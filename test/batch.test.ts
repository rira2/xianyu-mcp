/**
 * `runBatch`, the orchestration behind `search_batch`, with a fake `searchOne`.
 *
 * No browser and no site: what is pinned here is the part a bulk scan depends on -- input order,
 * per-query isolation, one deadline, one cooldown, and totals that agree with the rows. `searchOne`
 * is whatever the caller injected, so this file can make it answer, return empty, stop early, throw
 * a throttle or simply not answer until the deadline passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATCH_DEADLINE_MARGIN_MS, runBatch } from '../src/batch.ts';
import { XianyuError } from '../src/errors.ts';
import { executeTool } from '../src/response.ts';
import { recordPartial, withDeadline } from '../src/runtime.ts';
import { TOOLS } from '../src/tools.ts';

/** One listing in the shape `searchItems` publishes: the flat fields plus the typed block the price
 *  statistics and `compact` read. `image_urls` is here because compaction drops it, which is how the
 *  compact tests can tell compact output from full. */
const listing = (id: string, amount = 100) => ({
  item_id: id, rank: 1, title: `listing ${id}`, price: String(amount), typed: { price_amount: amount },
  city: '杭州', seller: 's', want_count: '1', image_urls: ['https://img.example/x.jpg'], url: `https://www.goofish.com/item?id=${id}`,
});
/** A search answer: the fields `runBatch` reads out of one, and nothing it has to invent. */
const answer = (ids: string[], extra: Record<string, any> = {}) => ({
  query: 'q', source: 'search_api', via: 'search_replay', count: ids.length, items: ids.map((id) => listing(id)),
  pages_fetched: 1, cache: { hits: 0, misses: 1, ttl_s: 60, pages: [] }, ...extra,
});
const noCooldown = () => ({ retry_after_s: 0 });
const opts = (over: Record<string, any> = {}) => ({ deadline: Date.now() + 60_000, cooldown: noCooldown, ...over });

test('runs its queries in order and answers once, compactly', async () => {
  const asked: string[] = [];
  const out = await runBatch({ queries: [{ query: 'alpha' }, { query: 'beta' }, { query: 'gamma' }] }, async (args) => {
    asked.push(args.query);
    return answer([`${args.query}-1`, `${args.query}-2`]);
  }, opts());
  assert.deepEqual(asked, ['alpha', 'beta', 'gamma'], 'sequential, in the order asked');
  assert.deepEqual(out.queries.map((q: any) => [q.index, q.query]), [[0, 'alpha'], [1, 'beta'], [2, 'gamma']]);
  assert.equal(out.partial, false);
  assert.equal(out.stop_reason, null);
  assert.deepEqual(out.failed_queries, []);
  assert.equal(out.count, 6);
  assert.ok(Number.isFinite(out.totals.ms) && out.totals.ms >= 0);
  assert.deepEqual({ ...out.totals, ms: 0 }, { requested: 3, ok: 3, empty: 0, failed: 0, skipped: 0, partial: 0, listings: 6, unique_listings: 6, duplicates: 0, ms: 0 });
  for (const entry of out.queries) {
    assert.equal(entry.ok, true);
    assert.equal(entry.status, 'success');
    assert.equal(entry.count, 2);
    assert.equal(entry.source, 'search_api');
    assert.equal(entry.via, 'search_replay');
    assert.equal(entry.pages_fetched, 1);
    assert.equal(entry.items.length, 2);
    assert.equal(entry.items[0].image_urls, undefined, 'compact by default: the deal fields only');
    assert.equal(entry.items[0].typed, undefined, 'and no typed block either');
    assert.equal(entry.price_stats.count, 2, 'the price statistics are over the kept listings');
  }
});

test('compact: false keeps the full cards and their typed block', async () => {
  const out = await runBatch({ queries: [{ query: 'alpha' }], compact: false }, async () => answer(['1']), opts());
  assert.deepEqual(out.queries[0].items[0].image_urls, ['https://img.example/x.jpg']);
  assert.equal(out.queries[0].items[0].typed.price_amount, 100);
  assert.equal(out.queries[0].price_stats.median, 100);
});

test('a query that throws is a row, not the end of the call', async () => {
  const asked: string[] = [];
  const out = await runBatch({ queries: [{ query: 'alpha' }, { query: 'beta' }, { query: 'gamma' }] }, async (args) => {
    asked.push(args.query);
    if (args.query === 'beta') throw Object.assign(new Error('boom'), { details: { reason: 'unavailable', retryable: true, retry_after_s: 5 } });
    return answer([`${args.query}-1`, `${args.query}-2`]);
  }, opts());
  assert.deepEqual(asked, ['alpha', 'beta', 'gamma'], 'the failure did not stop the queries after it');
  const failed = out.queries[1];
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'error');
  assert.equal(failed.index, 1);
  assert.equal(failed.reason, 'unavailable');
  assert.equal(failed.retryable, true);
  assert.equal(failed.retry_after_s, 5);
  assert.equal(failed.error_type, 'Error');
  assert.match(failed.message, /boom/);
  assert.deepEqual(failed.items, [], 'a failed query still gets the row shape');
  assert.equal(failed.price_stats, null);
  assert.deepEqual(out.failed_queries, [1]);
  assert.equal(out.partial, true);
  assert.equal(out.retry_after_s, 5);
  assert.equal(out.count, 4, 'the two queries that answered are still counted');
  assert.equal(out.queries[0].items.length, 2);
  assert.equal(out.queries[2].items.length, 2);
  assert.equal(out.totals.failed, 1);
});

test('the call stops before starting a query that cannot fit, and names what it never reached', async () => {
  const asked: string[] = [];
  const out = await runBatch({ queries: [{ query: 'alpha' }, { query: 'beta' }, { query: 'gamma' }] }, async (args) => {
    asked.push(args.query);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return answer([`${args.query}-1`]);
  }, opts({ deadline: Date.now() + 16_500 }));
  assert.deepEqual(asked, ['alpha'], 'one query fits in 16.5s; after it, the rest is under the 10s floor plus the 5s reserve');
  assert.equal(out.stop_reason, 'timeout');
  assert.equal(out.partial, true);
  for (const skipped of out.queries.slice(1)) {
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.ok, false);
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.stop_reason, 'timeout', 'the row names the deadline it was skipped for');
    assert.equal(skipped.reason, 'timeout');
    assert.equal(skipped.error_type, 'XianyuError', 'a published error type: batch rows never invent one');
    assert.match(skipped.message, /time budget/);
    assert.equal(skipped.retry_after_s, 0);
    assert.equal(skipped.ms, 0);
    assert.deepEqual(skipped.items, []);
  }
  assert.deepEqual(out.failed_queries, [1, 2]);
  assert.equal(out.totals.skipped, 2);
  assert.equal(out.count, 1);
});

test('a query is granted only what remains before the batch deadline, less the reserve', async () => {
  const seen: { at: number; timeout_s: number }[] = [];
  const deadline = Date.now() + 17_000;
  const out = await runBatch({ queries: [{ query: 'alpha' }], per_query_timeout_s: 60 }, async (args) => {
    seen.push({ at: Date.now(), timeout_s: args.timeout_s });
    return answer(['1']);
  }, opts({ deadline }));
  assert.equal(out.queries[0].status, 'success');
  assert.equal(seen.length, 1);
  const { at, timeout_s } = seen[0];
  assert.ok(timeout_s >= 10, 'the 10s floor is still granted when it fits');
  assert.ok(timeout_s <= 12, `17s less the 5s reserve leaves at most 12s for this query, got ${timeout_s}`);
  // The property the fix is for: start + grant is inside the batch deadline, so the envelope's
  // deadline (which is a further margin away) cannot fire while this query is still running.
  assert.ok(at + timeout_s * 1000 <= deadline - BATCH_DEADLINE_MARGIN_MS + 1000, `${at + timeout_s * 1000} exceeds ${deadline - BATCH_DEADLINE_MARGIN_MS}`);
  assert.equal(out.stop_reason, null);
  assert.equal(out.partial, false);
});

/** The published `search_batch` definition with only its `run` replaced. The two cases below simulate
 *  an envelope deadline (`executeTool`'s `withDeadline`) in milliseconds rather than seconds: the
 *  real wrapper would put the batch's own deadline 5s before a real envelope, which is the behaviour
 *  under test but costs 15+ seconds to reach. The schema, `runBatch`, the runtime and the envelope
 *  are the real ones. */
const served = (run: (args: any) => Promise<Record<string, any>>) => ({ ...TOOLS.find((t) => t.name === 'search_batch')!, run });

test('a batch answer pays the slim build block by default, and include_meta buys the full one', async () => {
  // The full block carries the runtime fingerprint, the deploy verdict and the base commit; on a scan
  // envelope that is ~0.7KB of meta a caller reads once, if ever. The default is the two fields an
  // agent cannot reconstruct: which version, which commit.
  const run = served((args) => runBatch(args, async () => answer(['1']), { deadline: Date.now() + 60_000, cooldown: noCooldown }));
  const slim = await executeTool(run, { queries: [{ query: 'alpha' }] });
  assert.deepEqual(Object.keys(slim.build).sort(), ['commit', 'version']);
  const full = await executeTool(run, { queries: [{ query: 'alpha' }], include_meta: true });
  assert.match(full.build.runtime_fingerprint, /^[a-f0-9]{64}$/);
  // `elapsed_ms` is wall-clock and varies by a digit between two calls; strip it before comparing
  // payload sizes, or this test is flaky by exactly one byte under a loaded suite.
  const stable = (envelope: any) => { const copy = { ...envelope }; delete copy.elapsed_ms; return copy; };
  const saved = Buffer.byteLength(JSON.stringify(stable(full))) - Buffer.byteLength(JSON.stringify(stable(slim)));
  // The full block is 460-760B depending on whether the deploy verdict has anything to say; the
  // property is that the meta block is the whole difference, not a particular number of bytes.
  const metaDelta = Buffer.byteLength(JSON.stringify(full.build)) - Buffer.byteLength(JSON.stringify(slim.build));
  assert.ok(metaDelta >= 400, `the slim default saved ${metaDelta}B of meta, which is not a real block`);
  assert.equal(saved, metaDelta, 'the build block is the only payload difference between the two calls');
  assert.equal(slim.count, full.count, 'the metashape changed, not the answer');
});

test('a query that no longer fits ends the list as a partial with its completed rows, never a deadline error', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const asked: string[] = [];
  const out = await executeTool(served((args) => runBatch(args, async (q: any) => {
    asked.push(q.query);
    // The clock moves past the batch's own budget while the first query runs. The next one could
    // only be granted 8s, under its 10s floor, so it must be a named skip, not a started query.
    if (q.query === 'alpha') t.mock.timers.setTime(Date.now() + 3_000);
    return answer([`${q.query}-1`, `${q.query}-2`]);
  }, { deadline: Date.now() + 16_000, cooldown: noCooldown })), { queries: [{ query: 'alpha' }, { query: 'beta' }, { query: 'gamma' }] });
  assert.deepEqual(asked, ['alpha'], 'the later queries were never started');
  assert.equal(out.ok, true);
  assert.equal(out.status, 'partial');
  assert.equal(out.error_type, null);
  assert.equal(out.message, null);
  const data = out.data!;
  assert.deepEqual(data.queries.map((row: any) => row.status), ['success', 'skipped', 'skipped']);
  assert.equal(data.queries[0].items.length, 2, 'the listings alpha returned are still in the answer');
  assert.equal(data.queries[0].ok, true);
  assert.equal(data.count, 2);
  assert.equal(data.totals.skipped, 2);
  assert.equal(data.stop_reason, 'timeout');
  assert.equal(data.partial, true);
  assert.doesNotMatch(JSON.stringify(out), /Call deadline reached/, 'the batch stopped itself; the envelope never had to');
});

test('a deadline tear-down after a row publishes the completed rows, not a single-search partial', async () => {
  // The envelope fires while the second query is still in flight. The batch had recorded its rows as
  // a batch-shaped partial after the first one, and the in-flight search records its own page-level
  // partial in the meantime; the envelope must publish the batch, never the single query.
  const out = await executeTool(served(() => withDeadline(0.35, () => runBatch({ queries: [{ query: 'alpha' }, { query: 'beta' }] }, async (q: any) => {
    if (q.query === 'beta') {
      recordPartial({ query: 'beta', items: [listing('single')], count: 1 });
      return await new Promise<Record<string, any>>(() => {});
    }
    return answer(['alpha-1']);
  }, { deadline: Date.now() + 60_000, cooldown: noCooldown }))), { queries: [{ query: 'alpha' }, { query: 'beta' }] });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'partial');
  assert.equal(out.message, null);
  const data = out.data!;
  assert.ok(Array.isArray(data.queries), 'the published partial is the batch, with data.queries[] intact');
  assert.deepEqual(data.queries.map((row: any) => row.status), ['success', 'skipped']);
  assert.deepEqual(data.queries[0].items.map((item: any) => item.item_id), ['alpha-1'], 'the completed row survived');
  assert.equal(data.queries[1].skipped, true, 'the query that was in flight is a named skip');
  assert.equal(data.stop_reason, 'timeout');
  assert.equal(data.count, 1);
  assert.doesNotMatch(JSON.stringify(out), /"single"/, 'the in-flight single-search partial did not replace the batch');
  assert.doesNotMatch(JSON.stringify(out), /Call deadline reached/);
});

test('a deadline that has already passed skips the whole list instead of throwing', async () => {
  let asked = 0;
  const out = await runBatch({ queries: [{ query: 'alpha' }, { query: 'beta' }] }, async () => { asked++; return answer(['1']); }, opts({ deadline: Date.now() - 1 }));
  assert.equal(asked, 0, 'nothing is started on a call that is already over');
  assert.equal(out.stop_reason, 'timeout');
  assert.equal(out.partial, true);
  assert.deepEqual(out.queries.map((q: any) => q.status), ['skipped', 'skipped']);
  assert.deepEqual(out.failed_queries, [0, 1]);
  assert.equal(out.totals.skipped, 2);
  assert.equal(out.count, 0);
});

test('a row that reports a throttle stops the batch and latches the wait it must observe', async () => {
  const asked: string[] = [];
  const out = await runBatch({ queries: [{ query: 'alpha' }, { query: 'beta' }, { query: 'gamma' }] }, async (args) => {
    asked.push(args.query);
    throw Object.assign(new Error('throttled'), { details: { reason: 'rate_limited', retryable: true, retry_after_s: 60 } });
  }, opts());
  assert.deepEqual(asked, ['alpha'], 'the first query reported the throttle, so the other two were never asked');
  assert.equal(out.queries[0].status, 'error');
  assert.equal(out.queries[0].reason, 'rate_limited', 'the query that was asked carries the site\'s own reason');
  assert.equal(out.stop_reason, 'cooldown');
  assert.equal(out.throttle_reason, 'rate_limited', 'the envelope keeps goofish\'s own word for it');
  assert.equal(out.retry_after_s, 60);
  assert.equal(out.partial, true);
  assert.deepEqual(out.failed_queries, [0, 1, 2], 'the query that was asked failed on goofish\'s own reason, and the two after it were skipped');
  for (const skipped of out.queries.slice(1)) {
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.stop_reason, 'cooldown');
    assert.equal(skipped.reason, 'cooldown');
    assert.equal(skipped.error_type, 'XianyuError');
    assert.equal(skipped.retry_after_s, 60, 'the wait it must observe travels with the row');
    assert.match(skipped.message, /throttle|retry in 60s/);
    assert.equal(skipped.ok, false);
    assert.equal(skipped.ms, 0);
    assert.deepEqual(skipped.items, []);
  }
  assert.equal(out.totals.failed, 1, 'the query that was asked failed on the site\'s own reason');
  assert.equal(out.totals.skipped, 2, 'and the two after it were never reached, counted apart');
});

test('an answered query cut short by a throttle also stops the batch, and a throttled-only batch is partial', async () => {
  const asked: string[] = [];
  const out = await runBatch({ queries: [{ query: 'alpha' }, { query: 'beta' }] }, async (args) => {
    asked.push(args.query);
    return answer([`${args.query}-1`], { partial: true, stop_reason: 'risk_control', retry_after_s: 120 });
  }, opts());
  assert.deepEqual(asked, ['alpha']);
  assert.equal(out.queries[0].ok, true);
  assert.equal(out.queries[0].status, 'partial');
  assert.equal(out.queries[0].stop_reason, 'risk_control');
  assert.equal(out.queries[0].retry_after_s, 120, 'the partial search\'s own wait is published on its row');
  assert.equal(out.queries[1].skipped, true);
  assert.equal(out.queries[1].stop_reason, 'cooldown');
  assert.equal(out.queries[1].retry_after_s, 120, 'and latched, not replaced by the 60s fallback');
  assert.equal(out.throttle_reason, 'risk_control');
  assert.equal(out.stop_reason, 'cooldown');
  assert.equal(out.partial, true, 'a batch whose only answered query was throttled is partial, never a success');
  assert.equal(out.count, 1);
  assert.equal(out.totals.skipped, 1);
});

test('a refusal without explicit details is classified the way the tool envelope classifies it', async () => {
  const asked: string[] = [];
  const out = await runBatch({ queries: [{ query: 'alpha' }, { query: 'beta' }] }, async (args) => {
    asked.push(args.query);
    throw new Error('RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!');
  }, opts());
  assert.deepEqual(asked, ['alpha'], 'the message alone names the throttle, so the batch stops');
  assert.equal(out.queries[0].reason, 'rate_limited');
  assert.equal(out.queries[0].retry_after_s, 60);
  assert.equal(out.stop_reason, 'cooldown');
  assert.equal(out.throttle_reason, 'rate_limited');
});

test('a cooldown active before the first query skips the list and says so', async () => {
  let asked = 0;
  const out = await runBatch({ queries: [{ query: 'alpha' }, { query: 'beta' }] }, async () => { asked++; return answer(['1']); }, opts({ cooldown: () => ({ retry_after_s: 60 }) }));
  assert.equal(asked, 0);
  assert.equal(out.stop_reason, 'cooldown');
  assert.equal(out.throttle_reason, null, 'a process cooldown is not a row the site throttled');
  assert.equal(out.retry_after_s, 60);
  assert.equal(out.partial, true);
  for (const row of out.queries) {
    assert.equal(row.skipped, true);
    assert.equal(row.status, 'skipped');
    assert.equal(row.stop_reason, 'cooldown');
    assert.equal(row.retry_after_s, 60);
    assert.match(row.message, /cooldown/);
  }
});

test('a failed query keeps the cards the search had already validated', async () => {
  const out = await runBatch({ queries: [{ query: 'alpha' }] }, async () => {
    throw Object.assign(new Error('the call deadline reached the search'), { details: { reason: 'timeout', retryable: true, retry_after_s: 0 }, partial: { query: 'alpha', items: [listing('1'), listing('2')], count: 2 } });
  }, opts());
  const row = out.queries[0];
  assert.equal(row.ok, false, 'the query still failed');
  assert.equal(row.status, 'timeout', 'its own clock ran out, which is named apart from a refusal');
  assert.equal(row.count, 2, 'but the listings it had already validated are not thrown away');
  assert.deepEqual(row.items.map((i: any) => i.item_id), ['1', '2']);
  assert.equal(row.price_stats.count, 2);
  assert.equal(out.count, 2);
  assert.equal(out.totals.listings, 2, 'and they count as listings the caller paid for');
});

test('the totals count listings, unique listings and the overlap between queries', async () => {
  const out = await runBatch({ queries: [{ query: 'alpha' }, { query: 'beta' }] }, async (args) => answer(args.query === 'alpha' ? ['1', '2'] : ['2', '3']), opts());
  assert.equal(out.totals.listings, 4);
  assert.equal(out.totals.unique_listings, 3);
  assert.equal(out.totals.duplicates, 1);
  assert.equal(out.count, 4, 'count is every returned listing, duplicates included');
});

test('a query that answered with nothing is empty, one that stopped early is partial', async () => {
  const out = await runBatch({ queries: [{ query: 'alpha' }, { query: 'beta' }, { query: 'gamma' }] }, async (args) => {
    if (args.query === 'alpha') return answer([]);
    if (args.query === 'beta') return answer(['1'], { partial: true, stop_reason: 'timeout' });
    return answer(['2']);
  }, opts());
  assert.deepEqual(out.queries.map((q: any) => q.status), ['empty', 'partial', 'success']);
  assert.deepEqual(out.queries.map((q: any) => q.ok), [true, true, true], 'all three answered; status carries the difference');
  assert.equal(out.queries[0].price_stats, null, 'no prices to summarise');
  assert.equal(out.queries[1].stop_reason, 'timeout');
  assert.deepEqual([out.totals.ok, out.totals.empty, out.totals.partial, out.totals.failed], [1, 1, 1, 0]);
  assert.equal(out.partial, false, 'a query that stopped early is not a failed query');
  assert.equal(out.count, 2);
});

test('each query is sent with its own controls and the batch defaults', async () => {
  const seen: any[] = [];
  const out = await runBatch({
    queries: [
      { query: 'alpha' },
      { query: 'beta', pages: 2, limit: 90, detail: 3, topup_pages: 2, min_price: 10, max_price: 20, city: '北京', province: '北京', exclude_keywords: ['散热'], form_factor: 'pcie', bare_card_only: true },
    ],
    attempts: 3, per_query_timeout_s: 20,
  }, async (args) => { seen.push(args); return answer(['1']); }, opts());
  // A batch query walks only the pages it asked for unless it says otherwise: the depth control is 0
  // here even though `search_items` itself defaults to two top-up pages.
  assert.deepEqual(seen[0], { query: 'alpha', pages: 1, limit: 60, detail: 0, topup_pages: 0, attempts: 3, timeout_s: 20 });
  assert.deepEqual(seen[1], { query: 'beta', pages: 2, limit: 90, detail: 3, topup_pages: 2, attempts: 3, timeout_s: 20, min_price: 10, max_price: 20, city: '北京', province: '北京', exclude_keywords: ['散热'], form_factor: 'pcie', bare_card_only: true });
  assert.equal(out.queries.length, 2);
});

test('an empty query list is refused before anything is asked', async () => {
  let asked = 0;
  await assert.rejects(runBatch({ queries: [] }, async () => { asked++; return answer([]); }, opts()), (e: any) => e instanceof XianyuError && /queries/.test(e.message));
  assert.equal(asked, 0);
});

test('a batch row publishes a slim cache verdict: whether any page was cached, and how old it was', async () => {
  // `search_items` keeps the per-page block, because a single search's pages can be read at different
  // moments and the envelope should say which. A scan row is read for a price comparison in one go,
  // so all it needs is the two facts a caller acts on -- was goofish asked, and how old is the answer.
  const observed = new Date(Date.now() - 12_000).toISOString();
  const out = await runBatch({ queries: [{ query: 'alpha' }] }, async () => answer(['1'], {
    cache: { enabled: true, hits: 1, misses: 1, ttl_s: 120, note: 'one of two pages was served from cache, and this note is long enough to be the reason the block was slimmed',
      pages: [{ page: 1, hit: false, age_s: null, observed_at: new Date().toISOString() }, { page: 2, hit: true, age_s: 12, observed_at: observed }] },
  }), opts());
  assert.deepEqual(out.queries[0].cache, { hit: true, age_s: 12 }, 'no pages[], no note, no ttl: the row answer only');
  const live = await runBatch({ queries: [{ query: 'alpha' }] }, async () => answer(['1'], { cache: { enabled: true, hits: 0, misses: 1, ttl_s: 120, pages: [{ page: 1, hit: false, age_s: null }] } }), opts());
  assert.deepEqual(live.queries[0].cache, { hit: false, age_s: null }, 'a row read live says so rather than arriving without the block');
});

test('the per-query default is 30s, not 60: a 13-query scan is bounded by the call, not one slow row', async () => {
  // The batch's own deadline already stops starting queries, but one query granted 60s can sit inside
  // that budget for a minute before the next row starts. 30s is the published default now, and a
  // caller who wants the old long leash asks for it explicitly.
  const seen: any[] = [];
  const out = await runBatch({ queries: [{ query: 'alpha' }] }, async (args) => { seen.push(args.timeout_s); return answer(['1']); }, opts());
  assert.deepEqual(seen, [30], 'the default grant');
  assert.equal(out.queries[0].status, 'success');
  const explicit: any[] = [];
  await runBatch({ queries: [{ query: 'alpha' }], per_query_timeout_s: 60 }, async (args) => { explicit.push(args.timeout_s); return answer(['1']); }, opts({ deadline: Date.now() + 120_000 }));
  assert.deepEqual(explicit, [60], 'an explicit budget is still honoured');
});

test('a query that overruns its own budget is a timeout row, and the batch continues', async () => {
  // The query's own clock ran out: that is a different fact from "goofish refused it" and from "the
  // list never reached it". Its status is `timeout`, its retry hint is coherent (zero wait, timeout
  // reason), and the next query still runs -- one slow row must not end the scan.
  const asked: string[] = [];
  const out = await runBatch({ queries: [{ query: 'slow' }, { query: 'next' }] }, async (args) => {
    asked.push(args.query);
    if (args.query === 'slow') throw Object.assign(new XianyuError('goofish never served a usable result set for "slow"'), { details: { reason: 'timeout', retryable: true, retry_after_s: 0 } });
    return answer(['1']);
  }, opts());
  assert.deepEqual(asked, ['slow', 'next'], 'the query after the timeout still ran');
  const slow = out.queries[0];
  assert.equal(slow.status, 'timeout');
  assert.equal(slow.ok, false);
  assert.equal(slow.reason, 'timeout');
  assert.equal(slow.retryable, true);
  assert.equal(slow.retry_after_s, 0, 'timeout is the documented zero-wait reason');
  assert.match(slow.message, /result set/);
  assert.equal(out.queries[1].status, 'success');
  assert.equal(out.totals.failed, 1, 'a timeout row is a failed query in the totals');
  assert.equal(out.totals.ok, 1);
  assert.equal(out.totals.requested, 2);
  assert.equal(out.totals.ok + out.totals.empty + out.totals.partial + out.totals.failed + out.totals.skipped, 2);
  assert.deepEqual(out.failed_queries, [0]);
  assert.equal(out.partial, true);
});
