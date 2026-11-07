import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichListing, numberOrNull, priceOf } from '../src/extract.ts';
import { filterRows, hardwareOf, matchesGroups, queryDiagnostics, readCursor, relaxMatch, saveCursor, termGroups } from '../src/search-policy.ts';
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
test('the relaxed relevance rule is on by default and has one kill switch', () => {
  // On by default: goofish's own search is fuzzy, and refusing a page of real CPU listings because
  // only two of thirty titles carry the exact phrase is the behaviour this switch exists to change.
  assert.equal(relaxMatch({}), true);
  assert.equal(relaxMatch({ XIANYU_RELAX_MATCH: '1' }), true);
  assert.equal(relaxMatch({ XIANYU_RELAX_MATCH: '' }), true, 'only the literal 0 turns it off');
  assert.equal(relaxMatch({ XIANYU_RELAX_MATCH: '0' }), false);
});
test('explicit virtual display takes precedence, then DISPLAY, then automatic startup', () => {
  assert.equal(displaySetting({ XIANYU_DISPLAY: ':7', DISPLAY: ':0' }), ':7');
  assert.equal(displaySetting({ DISPLAY: ':0' }), ':0'); assert.equal(displaySetting({}), '');
});

test('a failed query suggests only its own words: the unmatched token dropped, or an explicit equivalent', async () => {
  // The `32G 2400 RECC` shape from the field report: three terms, the last one not in the titles.
  // Suggestions stay inside what the caller typed -- drop the term that never appeared, spell a term
  // the glossary knows under its other name, or name the related category the glossary records. No
  // synonym is invented beyond those tables, and the query itself is never offered back.
  const { suggestedQueries } = await import('../src/search-policy.ts');
  const memory = suggestedQueries('32G 2400 RECC', ['recc']);
  assert.ok(memory.includes('32G 2400'), `the dropped-token form is the obvious next query: ${JSON.stringify(memory)}`);
  assert.equal(memory.includes('32G 2400 RECC'), false, 'the query that just failed is not a suggestion');
  assert.deepEqual(suggestedQueries('32G 2400 RECC', ['recc']).length, new Set(memory).size, 'no duplicates');
  // An equivalent the glossary already owns, and a related category that is explicitly a suggestion.
  assert.deepEqual(suggestedQueries('Xeon E5 2680 v4', []), ['至强 E5 2680 v4']);
  assert.deepEqual(suggestedQueries('服务器', []), ['工控']);
  // A single-term query has nothing it can drop, and inventing a shorter one would be a different
  // question: the answer is an empty list, not a guess.
  assert.deepEqual(suggestedQueries('RECC', ['recc']), []);
  assert.deepEqual(suggestedQueries('recc', []), []);
});

test('diagnostics carry the suggested queries beside the unmatched tokens', async () => {
  const d = queryDiagnostics('32G 2400 RECC', [{ title: '三星 32G 2400 内存' }, { title: '海力士 32G 2400 内存条' }]);
  assert.deepEqual(d.unmatched_tokens, ['recc'], 'no title carried the third term');
  assert.deepEqual(d.suggested_queries, ['32G 2400'], 'computed from the unmatched token, on the same block');
  assert.equal(d.titles_inspected, 2);
});

test('match_mode all|any|phrase picks different titles from the same page, and refuses an empty query', async () => {
  const { matchingRows, titleMatches, partialTermRows } = await import('../src/search-policy.ts');
  const rows = [
    { title: '4U 服务器 机箱 全新' },   // every term, in order  -> phrase and all
    { title: '4U机箱 服务器' },        // every term, reordered -> all only
    { title: '4U 机箱 便宜出' },       // two of three
    { title: '服务器 机箱 配件' },     // two of three
    { title: '4U 静音风扇' },          // one term
    { title: '木瓜丝 广西特产' },      // none
  ];
  const groups = termGroups('4U 服务器 机箱');
  const titles = (mode: any) => matchingRows(rows, '4U 服务器 机箱', groups, mode).map((r: any) => r.title);
  // Phrase is the whole query, normalised: case, spaces and punctuation do not matter, order does.
  assert.deepEqual(titles('phrase'), ['4U 服务器 机箱 全新']);
  // All terms is today's rule: every term, any order.
  assert.deepEqual(titles('all'), ['4U 服务器 机箱 全新', '4U机箱 服务器']);
  // Any is one term, which is what the OR-relax falls back to.
  assert.deepEqual(titles('any'), ['4U 服务器 机箱 全新', '4U机箱 服务器', '4U 机箱 便宜出', '服务器 机箱 配件', '4U 静音风扇']);
  // The loosest useful rule is still not "everything": the unrelated card is never kept.
  assert.equal(titles('any').includes('木瓜丝 广西特产'), false);
  // A query with no terms is not a licence to match every title.
  for (const mode of ['all', 'any', 'phrase'] as const) assert.equal(titleMatches('anything', '', [], mode), false, mode);
  // The partial rule is the 60%-of-terms rescue, never fewer than two.
  assert.deepEqual(partialTermRows(rows, groups).map((r: any) => r.title), ['4U 服务器 机箱 全新', '4U机箱 服务器', '4U 机箱 便宜出', '服务器 机箱 配件']);
});
