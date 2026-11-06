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
import { runBatch } from '../src/batch.ts';
import { XianyuError } from '../src/errors.ts';

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
  assert.deepEqual({ ...out.totals, ms: 0 }, { requested: 3, ok: 3, empty: 0, failed: 0, partial: 0, listings: 6, unique_listings: 6, duplicates: 0, ms: 0 });
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
    if (args.query === 'beta') throw Object.assign(new Error('boom'), { details: { reason: 'rate_limited', retryable: true, retry_after_s: 60 } });
    return answer([`${args.query}-1`, `${args.query}-2`]);
  }, opts());
  assert.deepEqual(asked, ['alpha', 'beta', 'gamma'], 'the failure did not stop the queries after it');
  const failed = out.queries[1];
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'error');
  assert.equal(failed.index, 1);
  assert.equal(failed.reason, 'rate_limited');
  assert.equal(failed.retryable, true);
  assert.equal(failed.retry_after_s, 60);
  assert.equal(failed.error_type, 'Error');
  assert.match(failed.message, /boom/);
  assert.deepEqual(failed.items, [], 'a failed query still gets the row shape');
  assert.equal(failed.price_stats, null);
  assert.deepEqual(out.failed_queries, [1]);
  assert.equal(out.partial, true);
  assert.equal(out.retry_after_s, 60);
  assert.equal(out.count, 4, 'the two queries that answered are still counted');
  assert.equal(out.queries[0].items.length, 2);
  assert.equal(out.queries[2].items.length, 2);
  assert.equal(out.totals.failed, 1);
});

test('the call deadline stops the batch and marks what it never reached', async () => {
  const asked: string[] = [];
  const out = await runBatch({ queries: [{ query: 'alpha' }, { query: 'beta' }, { query: 'gamma' }] }, async (args) => {
    asked.push(args.query);
    await new Promise((resolve) => setTimeout(resolve, 600));
    return answer([`${args.query}-1`]);
  }, opts({ deadline: Date.now() + 1000 }));
  assert.equal(asked.length, 2, 'the third query was never started, so the first two fit inside the 1s budget');
  assert.deepEqual(asked, ['alpha', 'beta']);
  assert.equal(out.stop_reason, 'timeout');
  assert.equal(out.partial, true);
  const skipped = out.queries[2];
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.ok, false);
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.error_type, 'TimeoutError', 'the row names the deadline it was skipped for');
  assert.match(skipped.message, /time budget|deadline/);
  assert.equal(skipped.reason, 'timeout');
  assert.equal(skipped.retry_after_s, 0);
  assert.equal(skipped.ms, 0);
  assert.deepEqual(skipped.items, []);
  assert.deepEqual(out.failed_queries, [2]);
  assert.equal(out.count, 2);
});

test('a process cooldown mid-batch stops it instead of spending the site on queries it expects refused', async () => {
  const asked: string[] = [];
  let wait = 0;
  const out = await runBatch({ queries: [{ query: 'alpha' }, { query: 'beta' }, { query: 'gamma' }] }, async (args) => {
    asked.push(args.query);
    wait = 60;   // the throttle this answer reports is what a process cooldown is set from
    throw Object.assign(new Error('throttled'), { details: { reason: 'rate_limited', retryable: true, retry_after_s: 60 } });
  }, opts({ cooldown: () => ({ retry_after_s: wait }) }));
  assert.deepEqual(asked, ['alpha'], 'goofish was asked exactly once');
  assert.equal(out.stop_reason, 'cooldown');
  assert.equal(out.partial, true);
  assert.equal(out.retry_after_s, 60);
  assert.deepEqual(out.failed_queries, [0, 1, 2], 'the query that was asked failed on goofish\'s own reason, and the two after it were skipped');
  assert.equal(out.queries[0].reason, 'rate_limited', 'the query that was asked carries the site\'s own reason');
  assert.equal(out.queries[0].status, 'error');
  for (const skipped of out.queries.slice(1)) {
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.error_type, 'CooldownError');
    assert.equal(skipped.reason, 'cooldown');
    assert.equal(skipped.retry_after_s, 60, 'the wait it must observe travels with the row');
    assert.match(skipped.message, /60s|cooldown/);
    assert.equal(skipped.ok, false);
    assert.equal(skipped.ms, 0);
    assert.deepEqual(skipped.items, []);
  }
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
