/**
 * `search_batch`: one call, many queries, per-query isolation.
 *
 * A bulk scan is 8-12 keyword searches against the same site from one server process, and the retry
 * and sleep orchestration for that used to live in the caller's own script. The server is the better
 * place for it: it already knows what a throttle looks like (`cooldown`), what the call's deadline is
 * and that one page answers every query, so the walks have to be sequential. This module is the
 * orchestration only -- it never navigates, never shapes beyond `shapeSearchData`, and never turns
 * one query's failure into the call's failure.
 *
 * The rules it keeps:
 *   - sequential and in the order asked, because one page answers them all;
 *   - a throw is a row in `queries`, never the end of the call;
 *   - one deadline for the whole call, and the process cooldown consulted before every query;
 *   - a query is only started if its own minimum budget still fits, so the call stops itself rather
 *     than being cut off mid-query by the envelope's deadline;
 *   - a throttle a query reports stops the list, because every later query would spend the same
 *     patience;
 *   - a query the call never reached says `skipped: true`, so `ok: false` is never ambiguous between
 *     "goofish refused this" and "this was never asked";
 *   - the totals are computed from the rows, so a listing cannot be counted twice as a unique one.
 *
 * `searchOne` is injected rather than imported: `tools.ts` owns `searchItems`, and importing it here
 * (or importing this from there and back) would make the dependency a cycle.
 */
import { describe, XianyuError } from './errors.ts';
import { shapeSearchData } from './output.ts';
import { failureDetails } from './response.ts';
import { checkpoint } from './runtime.ts';

/** One query of a batch: the search arguments `search_items` takes, minus the ones a batch owns. */
export type BatchQuery = {
  query: string; pages?: number; limit?: number; detail?: number; topup_pages?: number;
  min_price?: number; max_price?: number; city?: string; province?: string; exclude_keywords?: string[];
  form_factor?: 'pcie' | 'sxm2' | 'sxm3' | 'sxm4' | 'sxm5'; bare_card_only?: boolean;
};
export type BatchArgs = {
  queries: BatchQuery[]; compact?: boolean; sort?: 'relevance' | 'price_asc' | 'price_desc' | 'newest';
  timeout_s?: number; attempts?: number; per_query_timeout_s?: number;
};
/** What `runBatch` calls per query. `tools.ts` passes `searchItems` itself. */
export type SearchOne = (args: any) => Promise<Record<string, any>>;

// The defaults a direct `runBatch` call gets when nobody parsed the schema first. They mirror
// `BATCH_ARGS` in tools.ts and live here so a test or a script driving this module directly gets the
// same batch the tool publishes: one page, sixty listings, no top-up, two attempts, sixty seconds.
const BATCH_PAGES = 1, BATCH_LIMIT = 60, BATCH_DETAIL = 0, BATCH_TOPUP_PAGES = 0, BATCH_ATTEMPTS = 2, PER_QUERY_TIMEOUT_S = 60;
// A per-query budget below this is a refusal rather than a budget: one search's own retry loop and a
// page load do not fit in less, and the search tool would spend the call learning that. It is also
// the smallest slice of the call's budget that can start another query at all.
const MIN_PER_QUERY_TIMEOUT_S = 10;
// Goofish's own words for "not now", and the wait a batch imposes when a row carries neither a
// `retry_after_s` nor a cooldown to inherit.
const THROTTLE_REASONS = ['rate_limited', 'risk_control'];
const THROTTLE_RETRY_S = 60;
/** Which budget ended the list. The envelope only publishes `timeout`/`cooldown`; the cause is what
 *  lets a skipped row say whether the call's deadline ran out, the process was cooling down, or a
 *  query reported Goofish's own throttle. */
type SkipCause = 'deadline' | 'cooldown' | 'throttled';

/** The site's own reason for a throttle, if this row carries one. A failed row names it in `reason`
 *  (from the thrown details); an answered-but-cut-short row names it in `stop_reason`. */
const throttleOf = (row: Record<string, any>): string | null => {
  const reason = typeof row.stop_reason === 'string' ? row.stop_reason : typeof row.reason === 'string' ? row.reason : '';
  return THROTTLE_REASONS.includes(reason) ? reason : null;
};

/** A row for a query the call never reached. `error_type` stays inside `PUBLISHED_ERROR_TYPES` --
 *  `XianyuError` is what this server calls a refusal of its own, and the row was never thrown -- while
 *  `stop_reason`/`reason` say which budget ended the list and `retry_after_s` says what to observe. */
const skippedRow = (index: number, query: string, cause: SkipCause, wait: number): Record<string, any> => {
  const reason = cause === 'deadline' ? 'timeout' : 'cooldown';
  const message = cause === 'deadline'
    ? 'the whole call ran out of its time budget before this query could start; raise timeout_s, lower per_query_timeout_s, or send fewer queries'
    : cause === 'throttled'
      ? `an earlier query in this batch reported Goofish's throttle, so the batch stopped rather than spend the site's patience on queries it expects refused; retry in ${wait}s`
      : `this server process is in a throttle cooldown, so the batch stopped instead of spending the site's patience on queries it expects Goofish to refuse${wait ? `; retry in ${wait}s` : ' (the wait has since expired)'}`;
  return {
    index, query, ok: false, status: 'skipped', skipped: true, count: 0, ms: 0,
    error_type: 'XianyuError', message, stop_reason: reason, reason,
    retryable: true, retry_after_s: cause === 'deadline' ? 0 : wait,
    items: [], price_stats: null,
  };
};

/** What one answered query publishes: the route and depth it cost, and the listings it kept. */
const answeredRow = (index: number, query: string, data: Record<string, any>, ms: number, compact: boolean, sort: BatchArgs['sort']): Record<string, any> => {
  const shaped = shapeSearchData(data, { compact, sort });
  const items = Array.isArray(shaped.items) ? shaped.items : [];
  return {
    index, query, ok: true,
    status: data.partial ? 'partial' : items.length ? 'success' : 'empty',
    count: items.length, ms,
    ...(shaped.source ? { source: shaped.source } : {}),
    ...(shaped.via ? { via: shaped.via } : {}),
    ...(Number.isFinite(shaped.pages_fetched) ? { pages_fetched: shaped.pages_fetched } : {}),
    ...(shaped.stop_reason ? { stop_reason: shaped.stop_reason } : {}),
    // A partial search publishes the wait it wants observed; keep it so a throttle-latched batch
    // carries goofish's own number instead of the fallback.
    ...(Number.isFinite(shaped.retry_after_s) ? { retry_after_s: Number(shaped.retry_after_s) } : {}),
    ...(shaped.cache ? { cache: shaped.cache } : {}),
    items, price_stats: shaped.price_stats ?? null,
  };
};

/** What one refused query publishes. The reason is goofish's own when the tool carried one, and the
 *  failure details stay flat so a caller can act on `retryable` / `retry_after_s` without opening
 *  anything. Cards the failing search had already validated (`e.partial`) are kept: they were paid
 *  for, and the tool envelope keeps them on a deadline too. */
const failedRow = (index: number, query: string, e: unknown, ms: number, compact: boolean, sort: BatchArgs['sort']): Record<string, any> => {
  const { error_type, message } = describe(e);
  // The same classifier the tool envelope uses, so a refusal that carries no explicit details is
  // named the way the envelope would name it instead of reading as an anonymous error.
  const details = failureDetails(e);
  let partial: any;
  try { partial = (e as any)?.partial; } catch { /* an opaque throw is still a row */ }
  const kept = partial && Array.isArray(partial.items) ? shapeSearchData(partial, { compact, sort }) : null;
  const items = kept && Array.isArray(kept.items) ? kept.items : [];
  const reason = typeof details.reason === 'string' ? details.reason : undefined;
  return {
    index, query, ok: false, status: 'error', count: items.length, ms, error_type, message,
    retryable: Boolean(details.retryable), retry_after_s: Number(details.retry_after_s) || 0,
    ...(reason ? { reason } : {}), items, price_stats: kept?.price_stats ?? null,
  };
};

/**
 * Run the list. `opts.deadline` is when this whole call must have stopped starting queries, and
 * `opts.cooldown` is the process's own throttle state, consulted before every query -- including the
 * first, because a caller that reached this module directly never passed `executeTool`'s check.
 *
 * The per-query budget is the smaller of `per_query_timeout_s` and what is left of the call, so a
 * query late in a long batch cannot promise Goofish more time than the call has. It is never below
 * `MIN_PER_QUERY_TIMEOUT_S`, which is why a query whose floor no longer fits is skipped instead of
 * started: granting ten seconds out of two used to let the envelope's deadline fire mid-query and
 * replace the whole answer with "Call deadline reached".
 */
export const runBatch = async (args: BatchArgs, searchOne: SearchOne, opts: { deadline: number; cooldown: () => { retry_after_s: number } }): Promise<Record<string, any>> => {
  const asked = Array.isArray(args?.queries) ? args.queries : [];
  // The tool schema refuses an empty list, but `run()` is callable directly (this module's own tests,
  // a script), and "zero queries" would otherwise be a successful empty batch that costs the site
  // nothing and tells the caller nothing.
  if (!asked.length) throw new XianyuError('queries must not be empty: give 1-20 query objects, each with at least a query string');
  const compact = args.compact ?? true, sort = args.sort ?? 'relevance';
  const attempts = args.attempts ?? BATCH_ATTEMPTS, perQueryS = args.per_query_timeout_s ?? PER_QUERY_TIMEOUT_S;
  const started = Date.now(), rows: Record<string, any>[] = [];
  let stopCause: SkipCause | null = null;
  // The wait a throttle-latched batch must observe, and Goofish's own word for it, so the envelope can
  // hand both to the caller and to the process-level cooldown `tools.ts` arms.
  let latchedWait = 0, throttleReason: string | null = null;
  for (let index = 0; index < asked.length; index++) {
    const entry = asked[index] ?? ({} as BatchQuery), query = String(entry?.query ?? '');
    // Read before every query, including the first: a caller that reached this module directly never
    // passed `executeTool`'s own cooldown refusal, and a cooldown can appear in the middle of a batch.
    const cooldownWait = opts.cooldown().retry_after_s;
    if (!stopCause) {
      // Stop before a query that cannot fit. This check comes before `checkpoint()` on purpose: the
      // envelope's deadline and this one are the same clock, so an exhausted budget must reach the
      // skip branch as a named `timeout` rather than throw out of the loop as a deadline error.
      if (Date.now() + MIN_PER_QUERY_TIMEOUT_S * 1000 > opts.deadline) stopCause = 'deadline';
      else if (cooldownWait) stopCause = 'cooldown';
      // The envelope can be torn down under this loop by `withDeadline`; `checkpoint` is how a module
      // that never builds an envelope still honours that. It is only asked when a query would start.
      else checkpoint();
    }
    if (stopCause) {
      rows.push(skippedRow(index, query, stopCause, stopCause === 'deadline' ? 0 : stopCause === 'throttled' ? latchedWait : cooldownWait));
      continue;
    }
    const { query: _query, pages = BATCH_PAGES, limit = BATCH_LIMIT, detail = BATCH_DETAIL, topup_pages = BATCH_TOPUP_PAGES, ...filters } = entry;
    const left = Math.floor((opts.deadline - Date.now()) / 1000);
    const timeout_s = Math.max(MIN_PER_QUERY_TIMEOUT_S, Math.min(perQueryS, left));
    const at = Date.now();
    let row: Record<string, any>;
    try {
      row = answeredRow(index, query, await searchOne({ query, pages, limit, detail, topup_pages, attempts, timeout_s, ...filters }), Date.now() - at, compact, sort);
    } catch (e) {
      row = failedRow(index, query, e, Date.now() - at, compact, sort);
    }
    rows.push(row);
    // A query that ran into Goofish's throttle is the one signal a batch must not swallow into a row
    // and then ignore: the next query would spend the same patience, so the list stops here and the
    // remaining rows say why.
    const throttled = throttleOf(row);
    if (throttled) {
      stopCause = 'throttled';
      latchedWait = Number(row.retry_after_s) || THROTTLE_RETRY_S;
      throttleReason = throttled;
    }
  }
  return totalsFor(asked.length, rows, stopCause, throttleReason, Date.now() - started);
};

/**
 * The one envelope. `count` is every listing returned (duplicates across queries included) because
 * that is what the caller paid for; `unique_listings` is what a merged scan actually holds, and
 * `duplicates` names the difference rather than leaving the two numbers to disagree silently.
 *
 * `failed` counts the queries that answered with an error and `skipped` the ones the call never
 * reached, so `ok + empty + partial + failed + skipped === requested` and the two reasons a query has
 * no answer are countable apart; `failed_queries` still names every index that did not answer, because
 * that is the list a caller retries. `ok` counts only rows that fully succeeded.
 */
const totalsFor = (requested: number, rows: Record<string, any>[], stopCause: SkipCause | null, throttleReason: string | null, ms: number): Record<string, any> => {
  const withStatus = (status: string) => rows.filter((row) => row.status === status).length;
  const failed = rows.filter((row) => !row.ok).map((row) => row.index);
  const listings = rows.reduce((sum, row) => sum + row.count, 0);
  const unique = new Set<string>();
  for (const row of rows) for (const item of row.items) if (item?.item_id) unique.add(String(item.item_id));
  return {
    queries: rows,
    totals: {
      requested, ok: withStatus('success'), empty: withStatus('empty'), failed: withStatus('error'), skipped: withStatus('skipped'), partial: withStatus('partial'),
      listings, unique_listings: unique.size, duplicates: listings - unique.size, ms,
    },
    failed_queries: failed,
    stop_reason: stopCause === 'deadline' ? 'timeout' : stopCause ? 'cooldown' : null,
    throttle_reason: throttleReason,
    count: listings,
    // A per-query `partial` is that query's own incomplete walk; the call itself only stops early on
    // the deadline or a cooldown, or misses a query outright.
    partial: failed.length > 0 || stopCause !== null,
    retry_after_s: rows.reduce((max, row) => Math.max(max, Number(row.retry_after_s) || 0), 0),
  };
};
