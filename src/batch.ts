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
 *   - a query the call never reached says `skipped: true`, so `ok: false` is never ambiguous between
 *     "goofish refused this" and "this was never asked";
 *   - the totals are computed from the rows, so a listing cannot be counted twice as a unique one.
 *
 * `searchOne` is injected rather than imported: `tools.ts` owns `searchItems`, and importing it here
 * (or importing this from there and back) would make the dependency a cycle.
 */
import { describe, XianyuError } from './errors.ts';
import { shapeSearchData } from './output.ts';
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
// page load do not fit in less, and the search tool would spend the call learning that.
const MIN_PER_QUERY_TIMEOUT_S = 10;

/** A row for a query the call never reached. `retry_after_s` is the cooldown it must observe, and 0
 *  for a deadline, which is not the site saying anything. */
const skippedRow = (index: number, query: string, reason: 'timeout' | 'cooldown', wait: number): Record<string, any> => ({
  index, query, ok: false, status: 'skipped', skipped: true, count: 0, ms: 0,
  error_type: reason === 'timeout' ? 'TimeoutError' : 'CooldownError',
  message: reason === 'timeout'
    ? 'the whole call ran out of its time budget before this query could start; raise timeout_s, lower per_query_timeout_s, or send fewer queries'
    : `this server process is in a throttle cooldown, so the batch stopped instead of spending the site's patience on queries it expects Goofish to refuse${wait ? `; retry in ${wait}s` : ' (the wait has since expired)'}`,
  retryable: true, retry_after_s: reason === 'cooldown' ? wait : 0, reason,
  items: [], price_stats: null,
});

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
    ...(shaped.cache ? { cache: shaped.cache } : {}),
    items, price_stats: shaped.price_stats ?? null,
  };
};

/** What one refused query publishes. The reason is goofish's own when the tool carried one, and the
 *  failure details stay flat so a caller can act on `retryable` / `retry_after_s` without opening
 *  anything. */
const failedRow = (index: number, query: string, e: unknown, ms: number): Record<string, any> => {
  const { error_type, message } = describe(e);
  let details: any;
  try { details = (e as any)?.details; } catch { /* an opaque throw is still a row */ }
  const reason = typeof details?.reason === 'string' ? details.reason : undefined;
  return {
    index, query, ok: false, status: 'error', count: 0, ms, error_type, message,
    retryable: Boolean(details?.retryable), retry_after_s: Number(details?.retry_after_s) || 0,
    ...(reason ? { reason } : {}), items: [], price_stats: null,
  };
};

/**
 * Run the list. `opts.deadline` is when this whole call must have stopped starting queries, and
 * `opts.cooldown` is the process's own throttle state, consulted before every query -- including the
 * first, because a caller that reached this module directly never passed `executeTool`'s check.
 *
 * The per-query budget is the smaller of `per_query_timeout_s` and what is left of the call, so a
 * query late in a long batch cannot promise Goofish more time than the call has. It is never below
 * `MIN_PER_QUERY_TIMEOUT_S`; the envelope's own deadline is what ends a call that overran, and a
 * search that was given two seconds would fail for a reason that is not the site's.
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
  let stopReason: 'timeout' | 'cooldown' | null = null;
  for (let index = 0; index < asked.length; index++) {
    const entry = asked[index] ?? ({} as BatchQuery), query = String(entry?.query ?? '');
    // The envelope can be torn down under this loop by `withDeadline`; `checkpoint` is how a module
    // that never builds an envelope still honours that.
    checkpoint();
    // Read before every query, including the first: a caller that reached this module directly never
    // passed `executeTool`'s own cooldown refusal, and a cooldown can appear in the middle of a batch.
    const cooldownWait = opts.cooldown().retry_after_s;
    if (!stopReason) {
      if (Date.now() >= opts.deadline) stopReason = 'timeout';
      else if (cooldownWait) stopReason = 'cooldown';
    }
    if (stopReason) {
      rows.push(skippedRow(index, query, stopReason, stopReason === 'cooldown' ? cooldownWait : 0));
      continue;
    }
    const { query: _query, pages = BATCH_PAGES, limit = BATCH_LIMIT, detail = BATCH_DETAIL, topup_pages = BATCH_TOPUP_PAGES, ...filters } = entry;
    const left = Math.floor((opts.deadline - Date.now()) / 1000);
    const timeout_s = Math.max(MIN_PER_QUERY_TIMEOUT_S, Math.min(perQueryS, left));
    const at = Date.now();
    try {
      rows.push(answeredRow(index, query, await searchOne({ query, pages, limit, detail, topup_pages, attempts, timeout_s, ...filters }), Date.now() - at, compact, sort));
    } catch (e) {
      rows.push(failedRow(index, query, e, Date.now() - at));
    }
  }
  return totalsFor(asked.length, rows, stopReason, Date.now() - started);
};

/**
 * The one envelope. `count` is every listing returned (duplicates across queries included) because
 * that is what the caller paid for; `unique_listings` is what a merged scan actually holds, and
 * `duplicates` names the difference rather than leaving the two numbers to disagree silently.
 */
const totalsFor = (requested: number, rows: Record<string, any>[], stopReason: 'timeout' | 'cooldown' | null, ms: number): Record<string, any> => {
  const withStatus = (status: string) => rows.filter((row) => row.status === status).length;
  const failed = rows.filter((row) => !row.ok).map((row) => row.index);
  const listings = rows.reduce((sum, row) => sum + row.count, 0);
  const unique = new Set<string>();
  for (const row of rows) for (const item of row.items) if (item?.item_id) unique.add(String(item.item_id));
  return {
    queries: rows,
    totals: {
      requested, ok: withStatus('success'), empty: withStatus('empty'), failed: failed.length, partial: withStatus('partial'),
      listings, unique_listings: unique.size, duplicates: listings - unique.size, ms,
    },
    failed_queries: failed,
    stop_reason: stopReason,
    count: listings,
    // A per-query `partial` is that query's own incomplete walk; the call itself only stops early on
    // the deadline or a cooldown, or misses a query outright.
    partial: failed.length > 0 || stopReason !== null,
    retry_after_s: rows.reduce((max, row) => Math.max(max, Number(row.retry_after_s) || 0), 0),
  };
};
