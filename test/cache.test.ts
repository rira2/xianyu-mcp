/**
 * The TTL cache, and the promise it has to keep: a cached answer is never allowed to read like a
 * live one. No network and no browser here beyond the fakes `tools.test.ts` already uses -- what is
 * pinned is that a hit costs nothing, says so, expires, and can be turned off, and that a miss is
 * always the safe answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getItem, getSearchPage, itemTtl, missed, notCached, on, pageReport, putItem, putSearchPage, reset, searchKey, searchTtl, stats } from '../src/cache.ts';

test('live pages age during a long walk even though they are cache misses', () => {
  const observed = new Date(Date.now() - 75000).toISOString();
  const report = pageReport([{ page: 1, hit: false, age_s: null, observed_at: observed }]);
  assert.equal(report.pages[0].age_s, null, 'cache lookup age is still distinct from observation age');
  assert.ok(report.pages[0].observation_age_s >= 75 && report.pages[0].observation_age_s < 76);
  assert.equal(report.pages[0].observed_at, observed);
});

test.afterEach(() => { reset(); for (const k of ['XIANYU_CACHE', 'XIANYU_CACHE_ITEM_TTL_S', 'XIANYU_CACHE_SEARCH_TTL_S']) delete process.env[k]; });

test('a listing read once is served again without asking, and says how old it is', () => {
  const listing = { item_id: '42', title: '男士羊毛呢大衣', price: '1999' };
  assert.equal(getItem('42'), null, 'nothing is cached before anything is stored');
  putItem('42', listing);
  const hit = getItem('42');
  assert.ok(hit);
  assert.equal(hit.value.title, '男士羊毛呢大衣');
  assert.equal(hit.verdict.hit, true);
  assert.equal(hit.verdict.key, 'item:42', 'the key is published, so a miss reads as a different thing asked for');
  assert.equal(hit.verdict.age_s, 0, 'stored and read in the same tick');
  assert.equal(hit.verdict.ttl_s, itemTtl());
  assert.match(String(hit.verdict.stored_at), /^\d{4}-\d\d-\d\dT[\d:.]+Z$/, 'an ISO timestamp, not a number of seconds');
  // The sentence is the part a caller actually reads, and it has to say the two things that matter:
  // that goofish was not asked, and that the listing may have changed underneath the answer.
  assert.match(hit.verdict.note, /goofish was not asked/);
  assert.match(hit.verdict.note, /sold, repriced or edited since/);
});

test('a hit is a copy, not a live handle into module state', () => {
  // `enrichDetails` merges a listing it was handed into a card it then publishes. If a hit handed out
  // the cached object itself, that merge would write through into the cache and the next caller would
  // get an answer nobody read off goofish.
  putItem('42', { item_id: '42', title: 'before' });
  const first = getItem('42')!;
  (first.value as any).title = 'mutated by a caller';
  assert.equal(getItem('42')!.value.title, 'before', 'the stored copy is untouched');
  putItem('42', { item_id: '42', title: 'x' });
  (getItem('42')!.value as any).nested = { deep: true };
  assert.equal((getItem('42')!.value as any).nested, undefined, 'and the copy is deep, not shallow');
});

test('only listings are stored, and never a falsy one', () => {
  putItem('7', null as any);
  putItem('8', undefined as any);
  putItem('9', 0 as any);
  assert.deepEqual([getItem('7'), getItem('8'), getItem('9')], [null, null, null],
    'there is no putFailure and no way to reach one: a refused answer must leave the cache as it found it');
  assert.equal(stats().listings, 0);
});

test('the TTL is a real TTL, and it is the one the tool publishes', async () => {
  process.env.XIANYU_CACHE_ITEM_TTL_S = '0';
  assert.equal(itemTtl(), 1, 'floored at a second: a typo cannot make the cache a no-op that claims to be on');
  process.env.XIANYU_CACHE_ITEM_TTL_S = '99999';
  assert.equal(itemTtl(), 600, 'and capped, so an override cannot open a window no measurement here supports');
  process.env.XIANYU_CACHE_ITEM_TTL_S = 'soon';
  assert.equal(itemTtl(), 45, 'garbage falls back to the default rather than to NaN');
  delete process.env.XIANYU_CACHE_ITEM_TTL_S;
  // A zero TTL expires immediately: the entry is written and the very next read is a miss.
  process.env.XIANYU_CACHE_ITEM_TTL_S = '1';
  putItem('42', { item_id: '42' });
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(getItem('42'), null, 'past the TTL the answer is asked for again, not served');
  assert.equal(stats().listings, 0, 'and an expired entry is not counted as still held');
  // The two stores are sized and windowed separately, and a search page is allowed a longer window
  // than a listing -- see the header for why that asymmetry is the right way round.
  assert.equal(itemTtl(), 1);
  assert.equal(searchTtl(), 120);
  assert.equal(stats().listings, 0);
  assert.equal(stats().search_pages, 0);
});

test('XIANYU_CACHE=0 is the kill switch, and it is honoured on every read', () => {
  putItem('42', { item_id: '42' });
  putSearchPage('x220', 1, { resultList: [] });
  assert.ok(getItem('42') && getSearchPage('x220', 1));
  process.env.XIANYU_CACHE = '0';
  assert.equal(on(), false);
  assert.equal(getItem('42'), null, 'a disabled cache is a miss, not a stale answer');
  assert.equal(getSearchPage('x220', 1), null);
  putItem('43', { item_id: '43' });
  assert.equal(getItem('43'), null, 'and nothing new is written while it is off');
  // and the miss says why, so "no cache" is never read as "the cache is broken"
  assert.match(missed('item:42', 45, 'this listing').note, /XIANYU_CACHE=0/);
  delete process.env.XIANYU_CACHE;
  putItem('43', { item_id: '43' });
  assert.ok(getItem('43'), 'and switching it back on needs no restart');
});

test('search pages are keyed on the query and the pager page, case-insensitively', () => {
  putSearchPage('Thinkpad X220', 1, { resultList: ['a'] });
  assert.ok(getSearchPage('Thinkpad X220', 1), 'the same query and page');
  assert.equal(searchKey('  Thinkpad X220 ', 1), 'search:thinkpad x220#1', 'trimmed and lowercased, because the relevance guard it is pooled through matches titles case-insensitively');
  assert.ok(getSearchPage('thinkpad x220', 1), 'a differently-cased query is the same search, not a second one to store');
  assert.equal(getSearchPage('thinkpad x220', 2), null, 'but page 2 is a different page');
  assert.equal(getSearchPage('x220', 1), null, 'and so is a different query');
  assert.equal(stats().search_pages, 1, 'one entry, not three');
});

test('the per-page report names every page, and never one age for a set of pages', () => {
  const both = pageReport([{ page: 1, hit: false, age_s: null }, { page: 2, hit: true, age_s: 12.5 }]);
  assert.equal(both.hits, 1);
  assert.equal(both.misses, 1);
  assert.equal(both.pages.length, 2);
  assert.equal(both.ttl_s, searchTtl());
  // A walk whose pages were read at different moments is the normal case here, so the report has to be
  // per page: one age for the whole set would be a claim about a set that does not exist.
  assert.match(both.note, /1 of 2 page\(s\) were served from this process's own cache/);
  const none = pageReport([{ page: 1, hit: false, age_s: null }]);
  assert.match(none.note, /every page below was read from goofish just now/);
  // The DOM fallback route never touches the cache, and says so rather than borrowing a key it never
  // looked anything up under.
  const bypass = notCached('this page of results', searchTtl());
  assert.deepEqual([bypass.hit, bypass.key, bypass.age_s, bypass.stored_at], [false, '', null, null]);
  assert.match(bypass.note, /neither reads nor writes the cache/);
});

test('the store is bounded, and evicts the least recently used entry', () => {
  // 16 search pages and 64 listings: the two largest answers this server can produce are a 50-listing
  // `detail` comparison and a ten-page walk, so the cache is sized to those rather than to a number
  // that looked tidy. What has to hold either way is that it does not grow without limit.
  for (let i = 0; i < 40; i++) putSearchPage(`q${i}`, 1, { resultList: [i] });
  assert.equal(stats().search_pages, 16);
  assert.equal(getSearchPage('q0', 1), null, 'the oldest went first');
  assert.ok(getSearchPage('q39', 1), 'the newest is there');
  // Re-reading promotes: touch q30 (still held), then push two more in, and it is still there while
  // the entries it was inserted ahead of are the ones that go.
  assert.ok(getSearchPage('q30', 1));
  putSearchPage('fresh-a', 1, {});
  putSearchPage('fresh-b', 1, {});
  assert.ok(getSearchPage('q30', 1), 'a recently read entry is not the next eviction');
  for (let i = 0; i < 100; i++) putItem(`item${i}`, { item_id: `item${i}` });
  assert.equal(stats().listings, 64);
});

test('stats() is what capabilities reports, and it names the two TTLs and the kill switch', () => {
  const s = stats();
  assert.deepEqual([s.enabled, s.item_ttl_s, s.search_page_ttl_s, s.listings, s.search_pages], [true, 45, 120, 0, 0]);
  assert.match(s.note, /XIANYU_CACHE=0/);
  // and the feed is named as deliberately not cached, because "the cache makes repeats fast" is only
  // true while what it holds is the same answer -- and goofish serves each visitor a different slice
  assert.match(s.note, /homepage feed deliberately is not/);
});

test('reset() empties both stores, so a test cannot answer the next call from this one', () => {
  putItem('42', { item_id: '42' });
  putSearchPage('x220', 1, {});
  reset();
  assert.deepEqual([getItem('42'), getSearchPage('x220', 1)], [null, null]);
  assert.deepEqual([stats().listings, stats().search_pages], [0, 0]);
});
