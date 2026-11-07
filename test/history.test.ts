/**
 * The process-local history store: a listing id is new once, and a later lower price is a drop
 * against the last price this process saw. The store is module state that outlives a call, so every
 * test starts and ends empty -- the same reason the caches have a `reset`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateBatchData, annotateSearchData, historyEnabled, observeListing, reset, stats } from '../src/history.ts';

test.beforeEach(() => { reset(); delete process.env.XIANYU_HISTORY; });
test.afterEach(() => { reset(); delete process.env.XIANYU_HISTORY; });

test('a first observation is new, and a later lower price is a drop against the last observed price', () => {
  const first = observeListing({ item_id: '1', typed: { price_amount: 100 } });
  assert.deepEqual({ is_new: first.is_new, first_seen_age_s: first.first_seen_age_s, drop: first.price_drop_amount, previous: first.previous_price }, { is_new: true, first_seen_age_s: 0, drop: null, previous: null });

  const second = observeListing({ item_id: '1', typed: { price_amount: 90 } });
  assert.deepEqual({ is_new: second.is_new, drop: second.price_drop_amount, previous: second.previous_price }, { is_new: false, drop: 10, previous: 100 });
  assert.ok(second.first_seen_age_s >= 0);

  // 95 is an increase against the last observed 90, so it is not a drop -- and the next comparison
  // is still against 95 rather than against the first price this process ever saw.
  const third = observeListing({ item_id: '1', typed: { price_amount: 95 } });
  assert.deepEqual({ is_new: third.is_new, drop: third.price_drop_amount, previous: third.previous_price }, { is_new: false, drop: null, previous: 90 });
});

test('a compact card carries the price flat; an unreadable price never invents a drop', () => {
  observeListing({ item_id: '2', price_amount: 50 });
  const seen = observeListing({ item_id: '2', price_amount: 40 });
  assert.deepEqual([seen.is_new, seen.price_drop_amount, seen.previous_price], [false, 10, 50]);
  const unknown = observeListing({ item_id: '2', price_amount: null });
  assert.deepEqual([unknown.price_drop_amount, unknown.previous_price], [null, 40]);
  // an unknown observation does not erase the last readable price, so the next one still compares
  // against 40 rather than against nothing
  const back = observeListing({ item_id: '2', price_amount: 45 });
  assert.deepEqual([back.price_drop_amount, back.previous_price], [null, 40]);
});

test('annotateSearchData marks every item, filters new_only, and reports known/new counts and drops', () => {
  observeListing({ item_id: 'a', typed: { price_amount: 1000 } });
  const data = () => ({
    query: 'x', count: 2, price_stats: { count: 1, min: 1000 },
    items: [{ item_id: 'a', price_amount: 900 }, { item_id: 'b', price_amount: 500 }],
  });

  const out = annotateSearchData(data(), {});
  assert.deepEqual(out.items.map((i: any) => [i.item_id, i.is_new]), [['a', false], ['b', true]]);
  assert.ok(out.items[0].first_seen_age_s >= 0);
  assert.equal(out.items[1].first_seen_age_s, 0);
  assert.equal(out.count, 2);
  assert.deepEqual(out.history, {
    tracked: 2, known_count: 1, new_count: 1,
    price_drops: [{ item_id: 'a', title: null, from: 1000, to: 900, drop_amount: 100, drop_percent: 10 }],
  });

  reset();
  observeListing({ item_id: 'a', typed: { price_amount: 1000 } });
  const filtered = annotateSearchData(data(), { new_only: true });
  assert.equal(filtered.count, 1, 'the count follows the filtered items');
  assert.deepEqual(filtered.items.map((i: any) => i.item_id), ['b']);
  assert.deepEqual([filtered.history.tracked, filtered.history.known_count, filtered.history.new_count], [2, 1, 1]);
  assert.equal(filtered.history.price_drops.length, 1, 'a drop on a suppressed known listing is still reported');
  // the price statistics describe what this answer returns, not the set before filtering
  assert.deepEqual([filtered.price_stats.count, filtered.price_stats.min], [1, 500]);
});

test('annotateBatchData marks each query\'s items, filters new_only, and totals new and known listings', () => {
  observeListing({ item_id: 'a', typed: { price_amount: 1000 } });
  const batch = () => ({
    queries: [
      { index: 0, query: 'q1', ok: true, status: 'success', count: 1, items: [{ item_id: 'a', price_amount: 900 }] },
      { index: 1, query: 'q2', ok: true, status: 'success', count: 1, items: [{ item_id: 'b', price_amount: 500 }] },
    ],
    totals: { requested: 2, ok: 2, empty: 0, failed: 0, skipped: 0, partial: 0, listings: 2, unique_listings: 2, duplicates: 0, ms: 5 },
  });

  const out = annotateBatchData(batch(), {});
  assert.deepEqual(out.queries.map((q: any) => q.items.map((i: any) => [i.item_id, i.is_new])), [[['a', false]], [['b', true]]]);
  assert.deepEqual([out.totals.new_listings, out.totals.known_listings], [1, 1]);
  assert.deepEqual([out.history.tracked, out.history.known_count, out.history.new_count], [2, 1, 1]);
  assert.deepEqual(out.history.price_drops.map((d: any) => [d.item_id, d.from, d.to]), [['a', 1000, 900]]);

  reset();
  observeListing({ item_id: 'a', typed: { price_amount: 1000 } });
  const filtered = annotateBatchData(batch(), { new_only: true });
  assert.deepEqual(filtered.queries.map((q: any) => q.items.length), [0, 1]);
  assert.equal(filtered.queries[0].status, 'empty', 'a row with nothing new left says so');
  // The totals count what the call now returns; history.known_count names what was suppressed.
  assert.deepEqual([filtered.totals.listings, filtered.totals.new_listings, filtered.totals.known_listings], [1, 1, 0]);
  assert.deepEqual([filtered.totals.ok, filtered.totals.empty], [1, 1]);
  assert.equal(filtered.history.known_count, 1);
});

test('XIANYU_HISTORY=0 disables the store and leaves annotate* untouched', () => {
  process.env.XIANYU_HISTORY = '0';
  assert.equal(historyEnabled(), false);
  const data = { count: 1, items: [{ item_id: '1', price_amount: 100 }] };
  assert.deepEqual(annotateSearchData(data, {}), data);
  const batch = { queries: [{ index: 0, items: [{ item_id: '1', price_amount: 100 }] }], totals: { listings: 1 } };
  assert.deepEqual(annotateBatchData(batch, {}), batch);
  assert.deepEqual([stats().enabled, stats().tracked], [false, 0]);
  process.env.XIANYU_HISTORY = '1';
  assert.equal(historyEnabled(), true);
});

test('the store is bounded at 20,000 ids and forgets the least recently seen', () => {
  assert.deepEqual([stats().capacity, stats().enabled], [20_000, true]);
  for (let i = 0; i < 20_001; i++) observeListing({ item_id: String(i), typed: { price_amount: 1 } });
  assert.equal(stats().tracked, 20_000);
  const evicted = observeListing({ item_id: '0', typed: { price_amount: 1 } });
  assert.equal(evicted.is_new, true, 'id 0 was the least recently seen, so it was evicted');
  assert.equal(stats().tracked, 20_000);
});

test('reset empties the store', () => {
  observeListing({ item_id: '1', typed: { price_amount: 1 } });
  assert.equal(stats().tracked, 1);
  reset();
  assert.equal(stats().tracked, 0);
});
