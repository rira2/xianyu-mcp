import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichListing, numberOrNull, priceOf } from '../src/extract.ts';
import { filterRows, hardwareOf, matchesGroups, queryDiagnostics, readCursor, saveCursor, termGroups } from '../src/search-policy.ts';
import { displaySetting } from '../src/display.ts';

test('mixed-language CPU matches preserve model terms and normalize spacing and punctuation', () => {
  assert.equal(matchesGroups('至强 E5-2680v4 处理器', termGroups('Xeon E5-2680 v4')), true);
  assert.equal(matchesGroups('至强 E5-2680 v3', termGroups('Xeon E5-2680 v4')), false);
  assert.equal(matchesGroups('至强 E5-2680v4', termGroups('Xeon E5-2680 v4', false)), false);
  const d = queryDiagnostics('Xeon E5-2680 v4', [{ title: '至强 E5-2680 v3' }]);
  assert.deepEqual(d.unmatched_tokens, ['v4']);
  assert.deepEqual(termGroups('显卡'), [['显卡']]);
  assert.deepEqual(queryDiagnostics('显卡', []).suggestions, ['计算卡']);
});
test('prices and counts normalize only explicit values, preserve zero and distinguish uncertainty', () => {
  assert.equal(numberOrNull('1.2万'), 12000); assert.equal(numberOrNull('2千'), 2000);
  assert.equal(priceOf('￥1,299元').amount, 1299);
  assert.equal(priceOf('1.2万').kind, 'approximate'); assert.equal(priceOf('1.2万').amount, 12000);
  assert.equal(priceOf('面议').kind, 'negotiable'); assert.equal(priceOf('¥').amount, null);
  assert.equal(priceOf('定金50，实价500').amount, null); assert.equal(priceOf('免费送').amount, null);
  assert.equal(priceOf('0').amount, 0); assert.equal(priceOf('-5').amount, null);
  assert.deepEqual([priceOf('100-200').kind, priceOf('100-200').min_amount, priceOf('100-200').max_amount], ['range', 100, 200]);
  assert.equal(enrichListing({ price: '', image_urls: [] }).typed.image_count, null);
});
test('filters reject unknown facts, accessories and conflicting form factors without inventing data', () => {
  const rows = [
    { item_id: '1', title: 'Tesla P100 PCIe 裸卡', price: '¥500', city: '北京' },
    { item_id: '2', title: 'Tesla P100 SXM2 裸卡', price: '400', city: '北京' },
    { item_id: '3', title: 'Tesla P100 PCIe 散热转接', price: '100', city: '北京' },
    { item_id: '4', title: 'Tesla P100 PCIe 裸卡', price: '面议', city: '北京' },
    { item_id: '5', title: 'Tesla P100 PCIe', price: '500', city: '北京' },
  ].map(enrichListing);
  const result = filterRows(rows, { min_price: 200, max_price: 600, city: '北京', form_factor: 'pcie', bare_card_only: true, exclude_keywords: ['转接'] });
  assert.deepEqual(result.items.map(x => x.item_id), ['1']);
  assert.equal(result.filters.scope, 'server_post_fetch'); assert.equal(result.filters.excluded_count, 4);
  assert.equal(hardwareOf('P100 SXM2 PCIe 转接').form_factor, null);
  assert.equal(hardwareOf('普通显卡').bare_card, null);
  assert.equal(rows[0].typed.location?.province, null);
});
test('continuations are opaque, query-bound and retain filters', () => {
  const cursor = saveCursor('P100', { form_factor: 'sxm2' }, 3);
  assert.equal(readCursor(cursor, 'P100').nextPage, 3);
  assert.equal(readCursor(cursor, 'P100').options.form_factor, 'sxm2');
  assert.throws(() => readCursor(cursor, 'V100'), /different query/);
  assert.throws(() => readCursor('not-a-cursor', 'P100'), /unknown or expired/);
});
test('explicit virtual display takes precedence, then DISPLAY, then automatic startup', () => {
  assert.equal(displaySetting({ XIANYU_DISPLAY: ':7', DISPLAY: ':0' }), ':7');
  assert.equal(displaySetting({ DISPLAY: ':0' }), ':0'); assert.equal(displaySetting({}), '');
});
