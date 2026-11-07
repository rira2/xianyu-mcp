/**
 * The output-shaping layer, without a server and without a browser.
 *
 * These four functions decide what a bulk scan costs in context: the compact card, the price
 * statistics over a result set, and the sorts. They run at the tool boundary on the envelope
 * `search_items` has already built, so `detail` enrichment and filter re-checks still see full cards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactItem, priceStats, shapeSearchData, sortItems } from '../src/output.ts';

/** A search card as the API route hands it over: the flat fields a `searchCase` row carries, plus the
 *  four blocks `enrichListing` adds to every route. Nothing here is a field the site does not send. */
const card = (over: Record<string, any> = {}): any => ({
  item_id: '856961429564', rank: 1, title: '联想Thinkpad X220 笔记本电脑 i5 2520M 9成新',
  price: '329', city: '北京', want_count: '5', seller: '卖家',
  image_urls: ['https://img.alicdn.com/bao/uploaded/i1/856961429564.jpg', 'https://img.alicdn.com/bao/uploaded/i2/856961429564.jpg'],
  url: 'https://www.goofish.com/item?id=856961429564',
  publish_time: '1784640276000', tags: ['包邮', '验货宝'],
  price_info: { raw: '329', currency: 'CNY', kind: 'exact', amount: 329, min_amount: null, max_amount: null },
  typed: { price_amount: 329, original_price_amount: null, image_count: 2, want_count: 5, view_count: null, collect_count: null,
    condition: null, published_at: '2026-07-28T02:44:36.000Z', updated_at: null,
    location: { province: null, city: '北京' }, shipping: null, seller_stats: null },
  hardware: { form_factor: null, bare_card: null, evidence: 'title_only', note: 'Unknown means the title does not establish this fact. Verify the listing and photos.' },
  missing: ['original_price_amount', 'view_count', 'collect_count', 'condition', 'updated_at', 'location.province', 'shipping', 'seller_stats'],
  ...over,
});

/** Two listings, one cheaper than the other and newer than the other, inside the envelope shape
 *  `searchItems` returns: the fields a caller keeps on a compact call, and the ones it is paying for. */
const envelope = (): Record<string, any> => ({
  query: 'thinkpad x220', source: 'search_api', via: 'searchbox', account_required: false, attempts: 1,
  attempt_log: [{ attempt: 1, via: 'searchbox', rendered: true, blocked: false }],
  count: 2,
  items: [
    card(),
    card({ item_id: '856961429565', rank: 2, title: '联想 X220 屏幕总成 原装', price: '199', publish_time: '1784990276000',
      typed: { ...card().typed, price_amount: 199 }, price_info: { ...card().price_info, raw: '199', amount: 199 } }),
  ],
  next_cursor: 'e3f1', freshness: { oldest_observation_age_s: 4, cached: false },
  diagnostics: { tokens: [{ token: 'x220', alternatives: ['x220'], matching_titles: 2 }], sample_titles: ['联想Thinkpad X220 笔记本电脑 i5 2520M 9成新'] },
});

test('compactItem keeps exactly the deal fields and stays under a third of the full card', () => {
  const full = card();
  const compact = compactItem(full);
  assert.deepEqual(compact, {
    item_id: '856961429564', rank: 1, title: '联想Thinkpad X220 笔记本电脑 i5 2520M 9成新',
    price: '329', price_amount: 329, city: '北京', want_count: '5', seller: '卖家',
    url: 'https://www.goofish.com/item?id=856961429564', tags: ['包邮', '验货宝'], publish_time: '1784640276000',
  });
  // The four blocks that make a card expensive: the typed view, the price decomposition, the title
  // guess about hardware, and the list of what the site omitted. None of them survives compaction.
  for (const dropped of ['typed', 'price_info', 'hardware', 'missing', 'image_urls']) assert.equal(dropped in compact, false, dropped);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length / 3,
    `compact ${JSON.stringify(compact).length}B is not under a third of full ${JSON.stringify(full).length}B`);
});

test('compactItem carries tags and publish_time only when the card has them', () => {
  assert.deepEqual(compactItem(card()).tags, ['包邮', '验货宝']);
  assert.equal(compactItem(card()).publish_time, '1784640276000');
  const bare = compactItem(card({ tags: [], publish_time: '' }));
  assert.deepEqual(Object.keys(bare).sort(), ['city', 'item_id', 'price', 'price_amount', 'rank', 'seller', 'title', 'url', 'want_count']);
});

test('compactItem carries the seller trust signals only when the card has them', () => {
  const withSeller = compactItem(card({ seller_id: 'SID==', seller_reviews: '663', seller_positive_rate: '73', seller_credit: '极好', seller_identity: '实名认证' }));
  assert.deepEqual(
    [withSeller.seller_id, withSeller.seller_reviews, withSeller.seller_positive_rate, withSeller.seller_credit, withSeller.seller_identity],
    ['SID==', 663, 73, '极好', '实名认证']);
  const bare = compactItem(card());
  for (const k of ['seller_id', 'seller_reviews', 'seller_positive_rate', 'seller_credit', 'seller_identity', 'seller_hidden']) assert.equal(k in bare, false, k);
  assert.equal(compactItem(card({ seller_hidden: true })).seller_hidden, true);
});

test('compactItem publishes a price amount only when the typed block has one', () => {
  // An unreadable price is null in the typed block, and a null here would read as "free" rather than
  // "unknown" -- the same distinction `typed.price_amount` exists to keep.
  const unpriced = compactItem(card({ typed: { ...card().typed, price_amount: null } }));
  assert.equal('price_amount' in unpriced, false);
  assert.equal(unpriced.price, '329', 'the raw string the site sent is still there');
});

test('priceStats is null when nothing was priced, and ignores a listing without a numeric price', () => {
  assert.equal(priceStats([]), null);
  assert.deepEqual(priceStats([{ typed: { price_amount: 100 } }, { typed: { price_amount: 200 } }, { typed: { price_amount: null } }]),
    { count: 2, min: 100, p10: 110, p25: 125, median: 150, p75: 175, p90: 190, max: 200, mean: 150, currency: 'CNY' });
  // Only `typed.price_amount` is measured: the flat string is not re-parsed, a non-finite number is
  // not a price, and a real zero is. Otherwise a scan's statistics would move with a parser change.
  assert.deepEqual(priceStats([{ price: '999' }, { typed: { price_amount: Number.NaN } }, { typed: { price_amount: Infinity } }, { typed: { price_amount: 0 } }]),
    { count: 1, min: 0, p10: 0, p25: 0, median: 0, p75: 0, p90: 0, max: 0, mean: 0, currency: 'CNY' });
  // mean is the one rounded figure: 400/3 would otherwise be a long float in every envelope
  assert.equal(priceStats([{ typed: { price_amount: 100 } }, { typed: { price_amount: 100 } }, { typed: { price_amount: 200 } }])?.mean, 133.33);
});

test('sortItems puts an unknown price last, renumbers the ranks and leaves the caller\'s array alone', () => {
  const items = [
    { item_id: 'a', rank: 1, typed: { price_amount: 300 } },
    { item_id: 'b', rank: 2, typed: { price_amount: null } },
    { item_id: 'c', rank: 3, typed: { price_amount: 100 } },
  ];
  const asc = sortItems(items, 'price_asc');
  assert.deepEqual(asc.map((i: any) => i.item_id), ['c', 'a', 'b']);
  assert.deepEqual(asc.map((i: any) => i.rank), [1, 2, 3]);
  const desc = sortItems(items, 'price_desc');
  assert.deepEqual(desc.map((i: any) => i.item_id), ['a', 'c', 'b']);
  assert.deepEqual(desc.map((i: any) => i.rank), [1, 2, 3]);
  assert.deepEqual(items.map((i: any) => [i.item_id, i.rank]), [['a', 1], ['b', 2], ['c', 3]], 'the input array is a copy');
});

test('sortItems relevance is a copy in the same order, with the ranks the server assigned', () => {
  const items = [{ item_id: 'a', rank: 1, typed: { price_amount: 300 } }, { item_id: 'b', rank: 2, typed: { price_amount: 100 } }];
  const same = sortItems(items, 'relevance');
  assert.deepEqual(same, items);
  assert.notEqual(same, items);
});

test('sortItems newest orders by publish_time descending and keeps undated cards last', () => {
  const items = [
    { item_id: 'old', rank: 1, publish_time: '1784640276000' },
    { item_id: 'undated', rank: 2 },
    { item_id: 'new', rank: 3, publish_time: '1784990276000' },
  ];
  const out = sortItems(items, 'newest');
  assert.deepEqual(out.map((i: any) => i.item_id), ['new', 'old', 'undated']);
  assert.deepEqual(out.map((i: any) => i.rank), [1, 2, 3]);
});

test('shapeSearchData in compact mode drops the evidence trail and keeps the continuation', () => {
  const out = shapeSearchData(envelope(), { compact: true });
  assert.equal(out.compact, true);
  assert.equal('attempt_log' in out, false, 'the per-attempt log is the caller\'s context, not its answer');
  assert.equal('sample_titles' in out.diagnostics, false);
  assert.deepEqual(out.diagnostics.tokens, [{ token: 'x220', alternatives: ['x220'], matching_titles: 2 }], 'the rest of the diagnostics stay');
  assert.equal(out.attempts, 1, 'the attempt count survives without the log');
  assert.equal(out.count, 2);
  assert.equal(out.next_cursor, 'e3f1');
  assert.deepEqual(out.freshness, { oldest_observation_age_s: 4, cached: false });
  assert.deepEqual(out.items.map((i: any) => i.item_id), ['856961429564', '856961429565']);
  assert.equal('typed' in out.items[0], false, 'the cards are compacted');
  assert.equal(out.price_stats.count, 2);
  assert.equal(out.price_stats.min, 199);
});

test('shapeSearchData never mutates the envelope it was given', () => {
  const input = envelope();
  const out = shapeSearchData(input, { compact: true, sort: 'price_desc' });
  assert.deepEqual(input.items.map((i: any) => i.item_id), ['856961429564', '856961429565']);
  assert.equal(input.attempt_log.length, 1);
  assert.deepEqual(input.diagnostics.sample_titles, ['联想Thinkpad X220 笔记本电脑 i5 2520M 9成新']);
  assert.equal(input.compact, undefined);
  assert.equal('price_stats' in out, true);
});

test('shapeSearchData with no options is additive: the full cards stay and price_stats is added', () => {
  const input = envelope();
  const out = shapeSearchData(input, {});
  assert.deepEqual(Object.keys(out).sort(), [...Object.keys(input), 'price_stats'].sort());
  assert.equal('compact' in out, false);
  assert.deepEqual(out.attempt_log, input.attempt_log);
  assert.equal(out.items[0].typed.price_amount, 329, 'the full card is what a non-compact caller keeps paying for');
  assert.deepEqual(out.price_stats, priceStats(input.items));
});

test('shapeSearchData sorts before it compacts, so newest still has the timestamp to sort on', () => {
  const out = shapeSearchData(envelope(), { compact: true, sort: 'newest' });
  assert.deepEqual(out.items.map((i: any) => i.item_id), ['856961429565', '856961429564']);
  assert.deepEqual(out.items.map((i: any) => i.rank), [1, 2]);
  assert.equal(out.price_stats.count, 2, 'the statistics describe the result set, not the first row order');
});

test('an empty result set still publishes price_stats, as null rather than a made-up zero', () => {
  const out = shapeSearchData({ query: 'x220', count: 0, items: [], empty_reason: 'no_inventory', next_cursor: null }, { compact: true });
  assert.equal(out.price_stats, null);
  assert.deepEqual(out.items, []);
  assert.equal(out.empty_reason, 'no_inventory');
});
