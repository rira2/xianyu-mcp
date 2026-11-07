/**
 * The in-page JavaScript, actually executed against a synthetic document.
 *
 * Nothing here reaches the network. These are the parsers that read goofish's two feed
 * card shapes, the item detail block and the recommendation rail, and this is the only
 * place their behaviour is observable without a browser -- so it is where the rail
 * cut-off and the detailParams / titleSummary split are pinned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailListing, enrichListing, FEED_NORMALIZE_JS, searchListings, hasAllTerms, isoOrNull, ITEM_SCRAPE_JS, listingTyped, missingPaths, MTOP_CALL_JS, MTOP_READY_JS, numberOrNull, queryTerms, RAIL_MARKERS, SCRAPE_CARDS_JS, sellerListings, sellerProfileOf } from '../src/extract.ts';
import { ITEM_FIELDS, SELLER_ITEM_PAGE_FIELDS, SELLER_PROFILE_FIELDS } from '../src/tools.ts';

const g = globalThis as any;
const realSetTimeout = g.setTimeout;
const setDoc = (text: string, sel: Record<string, any[]> = {}, location: string | { search?: string; pathname?: string } = '') => {
  g.document = { body: { innerText: text }, querySelectorAll: (s: string) => sel[s] ?? [], querySelector: () => null };
  g.location = { search: '', ...(typeof location === 'string' ? { search: location } : location) };
};
// These tests replace globals the page scripts read, so they put every one back: without this the
// file only passed in the order it happens to be written.
test.afterEach(() => { for (const k of ['document', 'location', 'window']) delete g[k]; g.setTimeout = realSetTimeout; });

test('searchListings carries the seller trust signals a card already prints', () => {
  const payload = { resultList: [{ data: { item: { main: {
    clickParam: { args: { item_id: '42', price: '329', seller_id: 'SID==', publishTime: '1784640276000', userIsUseFishShopCard: 'false', HideUserInfo: 'false' } },
    exContent: {
      detailParams: { itemId: '42', title: 't', soldPrice: '329' }, userNickName: '卖家', userAvatarUrl: 'http://img/x.jpg',
      userFishShopLabel: { tagList: [{ data: { content: '663条评价' } }, { data: { content: '好评率73%' } }] },
      fishTags: { r4: { tagList: [{ data: { content: '卖家信用极好' } }] } },
      userIdentityShow: '实名认证', hideUserInfo: false,
    },
  } } }, style: 'card', type: 'item' }] };
  const cards = searchListings(payload);
  assert.equal(cards.length, 1);
  const ex = cards[0]._ex;
  // The card's "好评率73%" is the site's recent label, NOT the seller's lifetime rate (the same seller
  // answered 99% on the detail API). It is published under a name that says which metric it is.
  assert.deepEqual([ex.seller_id, ex.seller_card_reviews, ex.seller_card_good_rate, ex.seller_credit, ex.seller_identity, ex.seller_hidden], ['SID==', '663', '73', '极好', '实名认证', false]);
  const row = FEED_NORMALIZE_JS({ rows: cards })[0];
  assert.deepEqual([row.seller_id, row.seller_card_reviews, row.seller_card_good_rate, row.seller_credit, row.seller_identity, row.seller_hidden], ['SID==', '663', '73', '极好', '实名认证', false]);
  // The lifetime-rate names belong to the detail route; a card must not fill them with its own label.
  assert.equal('seller_positive_rate' in row, false);
  assert.equal('seller_reviews' in row, false);
  assert.equal(enrichListing(row).typed.seller_stats, null, 'the typed seller stats are the profile\'s, and a card has none');
  // Signals the card did not print stay empty rather than being invented.
  const bare = searchListings({ resultList: [{ data: { item: { main: { clickParam: { args: { item_id: '43', price: '1' } }, exContent: { detailParams: { itemId: '43' }, userNickName: 'x' } } } } }] })[0];
  assert.deepEqual([bare._ex.seller_id, bare._ex.seller_card_reviews, bare._ex.seller_card_good_rate, bare._ex.seller_credit], ['', '', '', '']);
});

test('the card good-rate and the lifetime good-rate never share a name', () => {
  // Verified against the same seller: the card's shop label said 73% over 663 reviews while the
  // detail record said 99% after 2071 sales. Publishing the card figure as `seller_positive_rate`
  // made a buyer compare two different metrics without knowing it.
  const detail = detailListing({
    itemDO: { itemId: '1083923766396', title: 't', soldPrice: '88' },
    sellerDO: { nick: 'x', sellerId: '2200778316916', newGoodRatioRate: '99%', replyRatio24h: '低于50', userRegDay: 730, hasSoldNumInteger: 2071, zhimaAuth: true },
  }, '1083923766396');
  assert.ok(detail);
  assert.equal(detail.seller_good_rate, 99, 'the lifetime rate as a number');
  assert.equal(detail.seller_positive_rate, '99', 'the legacy name still works, as the lifetime rate');
  assert.equal(detail.seller_reply_rate_24h, null, '"低于50" is not a number');
  assert.equal(detail.seller_reply_rate_24h_raw, '低于50', 'the site\'s own words survive beside the null');
  assert.equal(detail.seller_user_id, 2200778316916, 'the numeric seller id is what the seller tools take');
  assert.equal('seller_id' in detail, false, 'the opaque card id must not be overwritten by a numeric one under the same name');
  // A reply rate the site really stated is a number, and the raw field is not published twice.
  const numeric = detailListing({ itemDO: { itemId: '2' }, sellerDO: { replyRatio24h: '97%', newGoodRatioRate: '80%' } }, '2');
  assert.equal(numeric.seller_reply_rate_24h, 97);
  assert.equal('seller_reply_rate_24h_raw' in numeric, false);
  // Absent is absent: neither metric is invented from the other, and no rate becomes a zero.
  const bare = detailListing({ itemDO: { itemId: '3' }, sellerDO: {} }, '3');
  assert.equal(bare.seller_good_rate, null);
  assert.equal(bare.seller_reply_rate_24h, null);
  assert.equal(bare.seller_user_id, null);
});

test('a card\'s want count comes from the tag strip when the numeric field is a placeholder', () => {
  // Verified on item 1083923766396: `clickParam.args.wantNum` and `exContent.want` both carry the
  // placeholder "0"/empty, and the only real count is the "13人想要" tag. Publishing that zero as the
  // want count made every card look unwanted.
  const card = (wantNum: string, want: string, tags: string[]): any => searchListings({ resultList: [{ data: { item: { main: {
    clickParam: { args: { item_id: '1083923766396', price: '88', wantNum } },
    exContent: {
      detailParams: { itemId: '1083923766396', title: 'x' },
      ...(want ? { want } : {}),
      ...(tags.length ? { fishTags: { r2: { tagList: tags.map((c) => ({ data: { content: c } })) } } } : {}),
    },
  } } } }] })[0];
  const want = (c: any) => FEED_NORMALIZE_JS({ rows: [c] })[0].want_count;
  assert.equal(want(card('0', '', ['13人想要', '验货宝'])), '13');
  // "1.2万人想要" is a displayed magnitude, not a literal 1.2.
  assert.equal(want(card('0', '', ['1.2万人想要'])), '12000');
  assert.equal(want(card('', '', ['3人想要'])), '3');
  // A real number wins over the prose it prints beside.
  assert.equal(want(card('7', '', ['13人想要'])), '7');
  assert.equal(want(card('', '9', [])), '9', 'exContent.want is read through the same rule');
  // Nothing stated is nothing -- not a placeholder zero.
  assert.equal(want(card('0', '', [])), '');
  assert.equal(want(card('', '', [])), '');
  // ... and the typed block must not turn that absence into a zero either.
  assert.equal(enrichListing(FEED_NORMALIZE_JS({ rows: [card('0', '', [])] })[0]).typed.want_count, null);
});

test('the tag strip is split into condition, badges, price drop and attributes -- and nothing invented', () => {
  // A search card's strip mixes five kinds of statement in one array. Each is published under the name
  // that says what it is, while the raw `tags` array is kept for compatibility.
  const row = enrichListing(FEED_NORMALIZE_JS({ rows: [{
    detailParams: { itemId: '1083923766396', title: '联想 Thinkpad X220 笔记本', soldPrice: '329' },
    attributeMap: { wantNum: '0' },
    _ex: { tags: ['验货宝', '包邮', '累计降价12%', '13人想要', '轻微磕碰划痕', 'Lenovo/联想', '8GB', '卖家信用极好'] },
  }] })[0]);
  assert.deepEqual(row.badges, ['验货宝', '卖家信用极好']);
  assert.deepEqual(row.price_drop, { percent: 12 });
  assert.equal(row.condition, '轻微磕碰划痕');
  assert.deepEqual(row.attributes, { brand: 'Lenovo/联想', capacity: '8GB' });
  assert.deepEqual(row.tags, ['验货宝', '包邮', '累计降价12%', '13人想要', '轻微磕碰划痕', 'Lenovo/联想', '8GB', '卖家信用极好'], 'the raw strip is kept');
  // The typed block reads the condition the card really stated, whichever field carried it.
  assert.equal(row.typed.condition, '轻微磕碰划痕');
  // A stated flat condition beats the tag's, and the tag does not get a second life as a badge.
  assert.equal(enrichListing({ tags: ['几乎全新'], condition: '明显使用痕迹' }).condition, '明显使用痕迹');
  // Both price-drop wordings, published as the statement they make rather than a guessed percentage.
  assert.deepEqual(enrichListing({ tags: ['11小时前降价'] }).price_drop, { when: '11小时前' });
  assert.deepEqual(enrichListing({ tags: ['22天内降价'] }).price_drop, { when: '22天内' });
  // Nothing coercible: a tag the rules do not recognise is left in `tags` rather than filed under a
  // bucket that would be a guess.
  const unknown = enrichListing({ tags: ['满199减20'] });
  for (const k of ['badges', 'price_drop', 'attributes', 'condition']) assert.equal(k in unknown, false, k);
  const empty = enrichListing({ tags: [] });
  for (const k of ['badges', 'price_drop', 'attributes']) assert.equal(k in empty, false, k);
});

test('shipping evidence on a card comes from its tags or title, with its source, never from nothing', () => {
  const card = (tags: string[], title: string) => enrichListing({ item_id: 'x', title, tags });
  assert.deepEqual([card(['包邮'], 't').free_shipping, card(['包邮'], 't').shipping_source], [true, 'tag']);
  for (const tag of ['不包邮', '邮费另算', '到付']) {
    assert.deepEqual([card([tag], 't').free_shipping, card([tag], 't').shipping_source], [false, 'tag'], tag);
  }
  // The title is evidence too, and says so: "不包邮" must not be read as "包邮" just because it ends in it.
  assert.deepEqual([card([], '显卡 包邮').free_shipping, card([], '显卡 包邮').shipping_source], [true, 'title']);
  assert.equal(card([], '显卡 不包邮').free_shipping, false);
  // A tag strip is the more structured source, so it wins over the title when the two disagree.
  assert.equal(card(['包邮'], '显卡 到付').free_shipping, true);
  // No evidence at all is absent, not false: a listing whose shipping nobody stated is not a paid one.
  const none = card([], '显卡');
  assert.equal('free_shipping' in none, false);
  assert.equal('shipping_source' in none, false);
  // The detail route already knows the exact fee; its answer is not re-derived from a tag.
  const detail = enrichListing({ item_id: 'x', title: 't', tags: ['包邮'], shipping_fee: '20', free_shipping: false, shipping_source: 'detail' });
  assert.deepEqual([detail.free_shipping, detail.shipping_source], [false, 'detail']);
  // ... and the detail normaliser is where that exact fee becomes a boolean.
  const paid = detailListing({ itemDO: { itemId: '42', transportFee: '20' }, sellerDO: {} }, '42');
  assert.deepEqual([paid.shipping_fee, paid.free_shipping, paid.shipping_source], ['20', false, 'detail']);
  const free = detailListing({ itemDO: { itemId: '42', transportFee: '0.00' }, sellerDO: {} }, '42');
  assert.deepEqual([free.shipping_fee, free.free_shipping, free.shipping_source], ['0.00', true, 'detail']);
});

test('the mtop wrapper reports "not ready" instead of throwing, and keeps goofish\'s own ret code', async () => {
  g.setTimeout = ((fn: any) => setImmediate(fn)) as any;   // the readiness poll's 150ms x 60 would otherwise cost 9s
  g.window = {};
  assert.equal(MTOP_READY_JS(), 'pending');
  assert.equal((await MTOP_CALL_JS({ calls: [['a', 'x', {}]] })).fatal, 'mtop-not-ready');
  g.window = { lib: { mtop: { request: async () => ({ ret: ['SUCCESS::ok'], data: { n: 1 } }) } } };
  assert.equal(MTOP_READY_JS(), 'ready');
  const ok = (await MTOP_CALL_JS({ calls: [['a', 'x', {}]] })).a;
  assert.equal(ok.ok, true);
  assert.equal(ok.data.n, 1);
  // A rejected mtop call still carries the real code on `ret`; the JS message would throw it away.
  g.window = { lib: { mtop: { request: async () => { const e: any = new Error('js noise'); e.ret = 'RGV587_ERROR'; throw e; } } } };
  assert.equal((await MTOP_CALL_JS({ calls: [['a', 'x', {}]] })).a.ret, 'RGV587_ERROR');
  g.window = { lib: { mtop: { request: async () => { throw new Error('plain failure'); } } } };
  assert.equal((await MTOP_CALL_JS({ calls: [['a', 'x', {}]] })).a.ok, false);
  // a batch goes out concurrently, so a 25-page feed is one slow request rather than 25 of them
  let live = 0, peak = 0;
  g.window = { lib: { mtop: { request: async () => { peak = Math.max(peak, ++live); await new Promise((r) => setImmediate(r)); live--; return { ret: ['SUCCESS'], data: {} }; } } } };
  assert.equal(Object.keys(await MTOP_CALL_JS({ calls: Array.from({ length: 5 }, (_, i) => [`p${i}`, 'x', {}]) })).length, 5);
  assert.equal(peak, 5);
});

test('the feed normalizer reads both card shapes, and only the first one has attributeMap', () => {
  const rows = FEED_NORMALIZE_JS({ rows: [
    { cardData: { detailParams: { itemId: '111', title: 'A', soldPrice: '12.5', picUrl: 'p1', userNick: 'sellerA', isVideo: 'true' }, attributeMap: { wantNum: 7, originalPrice: '20', city: '杭州' } } },
    { itemId: '222', titleSummary: { text: 'B' }, priceInfo: { price: '99' }, images: [{ url: 'p2' }], user: { userNick: 'sellerB' }, hotPoint: { text: '1.2万人想要' } },
  ] });
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].item_id, rows[0].seller, rows[0].price, rows[0].city, rows[0].want_count, rows[0].is_video],
    ['111', 'sellerA', '12.5', '杭州', '7', true]);
  assert.deepEqual([rows[1].item_id, rows[1].seller, rows[1].price, rows[1].want_count, rows[1].image_urls[0]],
    ['222', 'sellerB', '99', '12000', 'p2']);
  assert.equal(rows[0].url, 'https://www.goofish.com/item?id=111');
  // a card with no item id is skipped rather than reported as a blank listing
  assert.deepEqual(FEED_NORMALIZE_JS({ rows: [{}, { detailParams: {} }] }), []);
});

test('a number the site dressed up is a number, and one that is not is null rather than zero', () => {
  assert.equal(numberOrNull('1,299'), 1299);
  assert.equal(numberOrNull('¥9'), 9);
  assert.equal(numberOrNull('80%'), 80);
  assert.equal(numberOrNull('12.50'), 12.5);
  assert.equal(numberOrNull(0), 0, 'the site saying zero is an answer, not an absence');
  // `Number('')` is 0, so a leftover that only *looked* like a number has to be caught by shape:
  // a bare currency mark or a run of whitespace otherwise reads as a price of zero, and a listing
  // nobody is charging for is the one value in a feed that must never be invented.
  assert.equal(numberOrNull('¥'), null);
  assert.equal(numberOrNull('   '), null);
  assert.equal(numberOrNull(''), null);
  assert.equal(numberOrNull(null), null);
  assert.equal(numberOrNull(undefined), null);
  assert.equal(numberOrNull('面议'), null, 'a price nobody has agreed is not a number');
  assert.equal(numberOrNull('1.2万'), 12000, 'normalize the displayed magnitude; price_info marks its precision');
  // the epoch is milliseconds on some payloads and seconds on others; the digit count decides
  assert.equal(isoOrNull('1784640276000'), '2026-07-21T13:24:36.000Z');
  assert.equal(isoOrNull('1784640276'), '2026-07-21T13:24:36.000Z');
  assert.equal(isoOrNull(1784640276000), '2026-07-21T13:24:36.000Z');
  // an already-ISO value passes through rather than through `Date` a second time
  assert.equal(isoOrNull('2026-07-21T13:24:36.000Z'), '2026-07-21T13:24:36.000Z');
  assert.equal(isoOrNull('2026-07-21'), '2026-07-21T00:00:00.000Z');
  assert.equal(isoOrNull('刚刚'), null, 'no invented date');
  assert.equal(isoOrNull(''), null);
});

test('the typed block reads a listing as types, and `missing` names every value the site left out', () => {
  // The detail API reply, the richest of the four routes. Everything the block has keys for is here,
  // which is the point: `missing` empty means the payload really did render all of it, not that the
  // block is a shorter shape this time.
  const full = detailListing({
    itemDO: {
      itemId: '42', title: '腾亚40C瓦斯钉抢', soldPrice: '366', desc: '刚保养清洗干净',
      wantCnt: 1, browseCnt: 34, collectCnt: 0, quantity: 1, itemStatusStr: '在线',
      transportFee: '0.00', gmtCreate: '1784640276000', gmtModified: '1784640999000',
      cpvLabels: [{ propertyName: '成色', valueName: '明显使用痕迹' }],
    },
    sellerDO: { nick: '今生有缘xy', province: '浙江省', city: '台州', userRegDay: 2256, hasSoldNumInteger: 369, newGoodRatioRate: '80%', replyRatio24h: '97%', zhimaAuth: true },
  }, '42');
  assert.ok(full, 'the payload is a listing');
  assert.deepEqual(listingTyped(full), {
    price_amount: 366, original_price_amount: null, image_count: null, want_count: 1, view_count: 34, collect_count: 0, condition: '明显使用痕迹',
    published_at: '2026-07-21T13:24:36.000Z', updated_at: '2026-07-21T13:36:39.000Z',
    location: { province: '浙江省', city: '台州' }, shipping: { fee: 0, free_shipping: true },
    seller_stats: { tenure_years: 6, items_sold: 369, positive_rate: 80, reply_rate_24h: 97, zhima_verified: true },
  });
  assert.deepEqual(missingPaths(listingTyped(full)), ['original_price_amount', 'image_count'], 'no original price was supplied');
  // collect_count 0 above is the load-bearing case: nobody has favourited it, which is a fact the
  // site stated, and rounding it to null would report a missing number instead of a real one.

  // A homepage feed card, the thinnest route: a name, a price, a city and a want count. Everything
  // else is a null in the block and a name in the list -- never inferred from a sibling, because the
  // one thing this server will not do is publish a field it did not read.
  const card = enrichListing(FEED_NORMALIZE_JS({ rows: [{ cardData: { detailParams: { itemId: '111', title: 'A', soldPrice: '12.5', userNick: 'sellerA' }, attributeMap: { wantNum: 0, city: '杭州' } } }] })[0]);
  assert.deepEqual(card.typed, { price_amount: 12.5, original_price_amount: null, image_count: null, want_count: null, view_count: null, collect_count: null, condition: null,
    published_at: null, updated_at: null, location: { province: null, city: '杭州' }, shipping: null, seller_stats: null });
  assert.deepEqual(card.missing, ['original_price_amount', 'image_count', 'want_count', 'view_count', 'collect_count', 'condition', 'published_at', 'updated_at', 'location.province', 'shipping', 'seller_stats']);
  assert.ok(card.missing.includes('location.province') && !card.missing.includes('location.city'),
    'the city was read, so only the province is absent -- the list is per-leaf, not per-object');

  // A null leaf is named on its own path (`b.d` while `b.c` is there), because that is the precise
  // answer. A null *object* is named once at its own path (`g`): `shipping: null` already says the
  // source had no fee at all, and listing `shipping.fee` and `shipping.free_shipping` separately would
  // say the same thing twice.
  assert.deepEqual(missingPaths({ a: null, b: { c: 1, d: null }, e: { f: null }, g: null }), ['a', 'b.d', 'e.f', 'g']);
  assert.deepEqual(missingPaths({ all: 'present' }), []);

  // The strings are untouched. This is the whole reason the block sits beside them rather than
  // replacing them: a field that changes type under an existing caller is a breaking change.
  assert.equal(card.price, '12.5');
  assert.equal(card.want_count, '', 'wantNum 0 is the placeholder, not a count');
  assert.equal(card.city, '杭州');
  assert.deepEqual(Object.keys(card).filter((k) => k === 'typed' || k === 'missing'), ['typed', 'missing']);
  // and the block never invents a province out of a city, which is the tempting one
  assert.equal(enrichListing({ price: '1', city: '杭州' }).typed.location?.province, null);
  // a fee of zero is free shipping on this site; a fee that was never rendered is not "free"
  assert.deepEqual(listingTyped({ shipping_fee: '0' }).shipping, { fee: 0, free_shipping: true });
  assert.deepEqual(listingTyped({ shipping_fee: '12' }).shipping, { fee: 12, free_shipping: false });
  assert.equal(listingTyped({}).shipping, null);
  // a boolean the payload never carried is not "not verified"
  assert.equal(listingTyped({ seller_tenure_years: '3' }).seller_stats!.zhima_verified, null);
});

test('the item scraper reads the detail head and refuses the rail below it', () => {
  const head = '男士羊毛呢大衣\n¥1999\n2人想要\n110浏览\n汴梁资深化镁\n来闲鱼4年 卖出27件宝贝 好评率100%\n专柜入手，穿过几次。\n';
  setDoc(head + '为你推荐\n¥5\n推荐卡片标题 ¥9', {
    '[class*="main-title"]': [{ textContent: '男士羊毛呢大衣' }, { textContent: '推荐卡片标题' }],
    // the want-counter really is in the head, so it is isCounter that has to reject it
    '[class*="desc--"]': [{ textContent: '2人想要' }, { textContent: '专柜入手，穿过几次。' }],
    '[class*="nick"]': [{ textContent: '汴梁资深化镁' }],
  }, '?id=1045171414271');
  const d = ITEM_SCRAPE_JS({ item_id: '1045171414271', rails: RAIL_MARKERS });
  assert.equal(d.detail_rendered, true);
  assert.equal(d.title, '男士羊毛呢大衣');
  assert.equal(d.price, '1999');
  assert.deepEqual([d.want_count, d.browse_count], ['2', '110']);
  assert.deepEqual([d.seller_tenure_years, d.seller_items_sold, d.seller_positive_rate], ['4', '27', '100']);
  // a want-counter sitting in a class containing "desc" is not the seller's description
  assert.equal(d.description, '专柜入手，穿过几次。');
  assert.equal(d.seller, '汴梁资深化镁');
  assert.deepEqual([d.requested_item_id, d.page_item_id], ['1045171414271', '1045171414271']);
  assert.equal(JSON.stringify(d).includes('推荐卡片'), false, 'a recommendation card leaked into the payload');
  // ITEM_FIELDS is what item_view promises; every one of those names has to be a key the scraper
  // really returns, or fields_present / fields_missing would describe a payload nobody produces.
  for (const f of ITEM_FIELDS) assert.ok(f in d, `item_view promises ${f}, which this scraper never returns`);
  // A path-form item URL is a served listing, not a wrong one: trusting `location.search` alone made
  // item_view refuse a correct page and call it a different listing.
  setDoc(head, {}, { pathname: '/item/777' });
  assert.equal(ITEM_SCRAPE_JS({ item_id: '777', rails: RAIL_MARKERS }).page_item_id, '777');
});

test('listing photos are the seller\'s own uploads: rail cards, banners, avatars and undecoded images excluded', () => {
  // The old rule was "big, on a known CDN host, not inside a card anchor", and it returned goofish's
  // own promo banners -- measured on a live page whose listing was a nail gun, the four URLs it gave
  // were four `-tps-242-150.png` strips from `gw.alicdn.com`. A banner is big and on a known CDN too.
  // The discriminator is the path: everything a seller uploaded is on `/bao/uploaded/`, and a banner
  // or an avatar is not.
  const anchorImg = { src: 'https://img.alicdn.com/bao/uploaded/card.jpg', naturalWidth: 400 };
  setDoc('大衣 ¥1\n1人想要', {
    "a[href*='/item?id=']": [{ querySelectorAll: () => [anchorImg] }],
    img: [
      anchorImg,                                                                   // a rail card's picture
      { src: 'https://gw.alicdn.com/imgextra/i4/O1CN-2-tps-242-150.png', naturalWidth: 242 }, // a promo banner: big, on a CDN, not a photo
      { src: 'https://gtms03.alicdn.com/tps/i3/avatar-200-200.png', naturalWidth: 200 },         // the seller avatar
      { src: 'https://img.alicdn.com/bao/uploaded/i4/gallery.jpg', naturalWidth: 400 },
      { src: 'https://img.alicdn.com/bao/uploaded/i4/undecoded.jpg', naturalWidth: 0 },
      // the thumbnail strip and the full-size preview are one photo at two sizes; they collapse
      { src: 'https://img.alicdn.com/bao/uploaded/i4/gallery.jpg_110x10000Q90.jpg_.webp', naturalWidth: 110 },
    ],
  });
  const d = ITEM_SCRAPE_JS({ item_id: '1', rails: RAIL_MARKERS });
  assert.deepEqual(d.image_urls, ['https://img.alicdn.com/bao/uploaded/i4/gallery.jpg']);
  assert.equal(d.image_candidates, 2, 'the same photo at two sizes is two candidates, one URL');
  assert.equal(d.reco_anchors, 1);
});

test('the listing title comes from the document title, because the detail block does not print it', () => {
  // Measured over 6 live listings: the detail block prints the price, the counts, the description and
  // the seller, and the title is nowhere in `innerText` -- so every class-name search for it either
  // found a recommendation card further down the page or nothing, and the field came back empty.
  const g = globalThis as any;
  g.document = {
    body: { innerText: '搜索\n今生有缘xy\n台州\n¥\n366\n1人想要\n28浏览\n描述文字' },
    title: '腾亚40C瓦斯钉抢，功能正常使用_闲鱼',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const d = ITEM_SCRAPE_JS({ item_id: '1', rails: RAIL_MARKERS });
  assert.equal(d.title, '腾亚40C瓦斯钉抢，功能正常使用', 'the _闲鱼 suffix is goofish\'s, not the listing\'s');
});

test('the empty shell goofish serves a throttled IP must not look rendered, but its text is still quoted', () => {
  setDoc('阿里巴巴集团 淘宝 天猫');
  const d = ITEM_SCRAPE_JS({ item_id: '1', rails: RAIL_MARKERS });
  assert.equal(d.detail_rendered, false);
  assert.equal(d.page_item_id, '');
  assert.match(d.head_preview, /阿里巴巴/);
});

const card = (id: string, title: string, price: string, city = '成都') => ({
  href: `https://www.goofish.com/item?id=${id}`,
  innerText: `${title} ${price}`,
  getAttribute: () => null,
  querySelector: (s: string) => (s.includes('price')
    ? { querySelector: (t: string) => ({ textContent: t.includes('number') ? price : '' }) }
    : s.includes('seller') ? { querySelector: () => ({ textContent: city }) } : { textContent: title }),
  querySelectorAll: () => [],
});

test('the card scraper dedupes by item id, honours limit, and counts real query hits', () => {
  setDoc('联想 X220 电池', { 'a[href*="/item?id="]': [card('9', '联想 X220 电池', '300'), card('9', 'dup', '1'), card('10', '相机', '1200')] });
  const out = SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 10, rails: RAIL_MARKERS });
  assert.deepEqual(out.items.map((i: any) => i.item_id), ['9', '10']);
  assert.equal(out.query_hits, 1, 'only the title that really contains the query is a hit');
  assert.deepEqual(out.items.map((i: any) => i.matches_query), [true, false]);
  assert.equal(out.items[0].price, '¥300');
  assert.equal(out.items[0].city, '成都');
  assert.equal(SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 1, rails: RAIL_MARKERS }).items.length, 1);
  // `limit` bounds what is kept, not what is counted: the caller needs the hit fraction over every
  // card on the page, so cards_scanned and query_hits both keep going past the limit.
  const capped = SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 1, rails: RAIL_MARKERS });
  assert.deepEqual([capped.items.length, capped.query_hits, capped.cards_scanned], [1, 1, 2]);
  // no per-item `source`: a search hit is not a recommendation, and the envelope says where it came from
  assert.equal('source' in out.items[0], false);
  // token_hits is the looser, *additional* count: a title that holds every word of the query in any
  // order is a hit the strict substring guard will not accept, and it has to be visible either way.
  setDoc('', { 'a[href*="/item?id="]': [card('30', '联想 X220 键盘 拆机', '50'), card('31', '键盘 X220 联想 全新', '50'), card('32', '相机 1200', '1')] });
  const words = SCRAPE_CARDS_JS({ query: 'x220 键盘', terms: queryTerms('x220 键盘'), limit: 10, rails: RAIL_MARKERS });
  assert.deepEqual([words.query_hits, words.token_hits, words.cards_scanned], [1, 2, 3]);
  const one_word = SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 10, rails: RAIL_MARKERS });
  assert.equal(one_word.token_hits, one_word.query_hits, 'one word: the two counts are the same thing');
});

test('a query matches a listing by its terms in any order, which is the only way this works here', () => {
  // goofish titles are in whatever word order the seller typed, and Chinese has no spaces, so an
  // exact-substring test rejects nearly everything on this site. Measured: a search for `机械硬盘4t`
  // -- 70,146 listings by goofish's own counter -- returned nothing, because the titles say
  // `西数4T机械硬盘`. These are the real splits.
  assert.deepEqual(queryTerms('机械硬盘4t'), ['机械硬盘', '4t']);
  assert.deepEqual(queryTerms('i350网卡'), ['i350', '网卡']);
  assert.deepEqual(queryTerms('显示器24寸'), ['显示器', '24寸']);
  assert.deepEqual(queryTerms('笔记本内存ddr4'), ['笔记本内存', 'ddr4']);
  assert.deepEqual(queryTerms('sata固态512g'), ['sata', '固态', '512g']);
  assert.deepEqual(queryTerms('thinkpad x220'), ['thinkpad', 'x220']);
  assert.deepEqual(queryTerms('自行车'), ['自行车'], 'one term, no boundary to find');
  assert.deepEqual(queryTerms(''), []);

  // the looser rule admits the reversed-word-order title the strict one rejects...
  const reversed = '西数红盘4T企业级机械硬盘 寄';
  assert.equal(reversed.toLowerCase().includes('机械硬盘4t'), false, 'the phrase really is not there');
  assert.equal(hasAllTerms(reversed, queryTerms('机械硬盘4t')), true);
  // ...and still refuses a rail card, which is the whole point of the guard
  assert.equal(hasAllTerms('全新自行车 山地车 骑行装备', queryTerms('机械硬盘4t')), false);
  assert.equal(hasAllTerms('机械硬盘 台式机内存条', queryTerms('机械硬盘4t')), false, 'half the terms is not a match');
  // and a one-word query is unchanged by any of this
  assert.equal(hasAllTerms('任意自行车', queryTerms('自行车')), true);
});

test('the card scraper keeps the rail out under the looser rule, not just the strict one', () => {
  // 30 cards on a declined search page: 18 recommendations and 12 real listings, none of which
  // carries the phrase. The strict rule counts none of the 12; the term rule counts 12, which clears
  // the fifth-of-the-page floor. If this had gone the other way the rail would be sold as results.
  const rail = Array.from({ length: 18 }, (_, i) => card(String(100 + i), `推荐好物 ${i} 全新`, '9'));
  const real = Array.from({ length: 12 }, (_, i) => card(String(200 + i), `西数红盘4T企业级机械硬盘 ${i}`, '199'));
  setDoc('', { 'a[href*="/item?id="]': [...rail, ...real] });
  const out = SCRAPE_CARDS_JS({ query: '机械硬盘4t', terms: queryTerms('机械硬盘4t'), limit: 50, rails: RAIL_MARKERS });
  assert.equal(out.cards_scanned, 30);
  assert.equal(out.query_hits, 0, 'no title carries the phrase, only the terms');
  assert.equal(out.token_hits, 12, 'and the term rule finds all twelve real ones');
  // the scraper publishes every card it saw and flags them; the caller keeps the flagged ones, and
  // that is where the rail stops being results.
  assert.equal(out.items.filter((i: any) => i.matches_query).length, 12, 'so only the real ones are flagged as matches');
  assert.equal(out.items.filter((i: any) => i.matches_phrase).length, 0, 'and it is honest that the phrase was not the match');
});

test('a declined anonymous search is distinguishable from a real result set, and from a risk-control page', () => {
  setDoc('小闲鱼没有找到你想要的宝贝~ 猜你喜欢', { 'a[href*="/item?id="]': [card('900', '木瓜丝广西特产', '9')] });
  const out = SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 10, rails: RAIL_MARKERS });
  assert.equal(out.rendered, true);
  assert.equal(out.query_hits, 0);
  assert.equal(out.rail, '猜你喜欢');
  assert.equal(out.says_no_results, true);
  // With no query (the recommendations path) nothing is claimed to match.
  assert.equal(SCRAPE_CARDS_JS({ query: '', terms: queryTerms(''), limit: 10, rails: RAIL_MARKERS }).items[0].matches_query, false);
  // goofish also answers this client with a risk-control page rather than the app: a 200 whose whole
  // body is 非法访问. It renders no cards and no rail, so without this flag the caller reports "no
  // results found" for a page the site never searched. Measured, so it is matched literally.
  setDoc('非法访问\n为了保障您的体验，请使用正常浏览器访问闲鱼~\n关闭\n反馈问题');
  assert.equal(SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 10, rails: RAIL_MARKERS }).blocked, true);
  setDoc('联想 X220 电池 ¥300');
  assert.equal(SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 10, rails: RAIL_MARKERS }).blocked, false);
  // One marker list, both scrapers. 猜你想看 is the one the card scraper was missing, and that gap is
  // what let a page headed with it and one query-matching card through as results; the list reaches
  // them as an argument (Playwright serialises the function and its one argument, nothing else), so
  // the only way to prove they read it is to hand them a list they do not otherwise have.
  assert.deepEqual(RAIL_MARKERS, ['为你推荐', '猜你喜欢', '猜你想看']);
  for (const marker of RAIL_MARKERS) {
    setDoc(`男士羊毛呢大衣\n1人想要\n${marker}\n专柜入手，穿过几次。`, {
      '[class*="main-title"]': [{ textContent: '男士羊毛呢大衣' }],
      '[class*="desc--"]': [{ textContent: '专柜入手，穿过几次。' }],
    });
    assert.equal(ITEM_SCRAPE_JS({ item_id: '1', rails: [marker] }).description, '', `${marker}: the item scraper did not cut the page at it`);
    setDoc(`小闲鱼 ${marker} 没有找到你想要的宝贝`, { 'a[href*="/item?id="]': [card('1', '联想X220', '300')] });
    assert.equal(SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 5, rails: [marker] }).rail, marker);
  }
  assert.equal(SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 5, rails: ['推荐位'] }).rail, '', 'a marker that is not in the list is not a rail');
});

// ---- the two seller normalisers. These are Node-side functions over a payload the page already
// produced, so unlike the in-page scripts above they need no synthetic document -- what is pinned here
// is the honesty of the mapping, which is the only thing a browser would not have caught.

/** A `mtop.idle.web.user.page.head` reply as captured off the wire, including the field that must NOT
 *  become a city: `ipLocation` is where goofish thinks this request came from, and it measured 上海市
 *  for a seller whose own listing record says 北京. */
const HEAD_PAYLOAD = {
  baseInfo: { kcUserId: '2214350705775', encryptedUserId: 'strZSeNsALQaHGp6qPRb3g==', tags: { real_name_certification_77: true, real_person_certification_77: true, idle_zhima_zheng: true, tb_xianyu_user: false } },
  module: {
    base: { ipLocation: '上海市', displayName: '汴梁资深化镁', introduction: '签名', avatar: { avatar: 'http://img.alicdn.com/a.jpg' },
      ylzTags: [{ attributes: { role: 'seller' }, text: '卖家信用极好' }, { attributes: { role: 'buyer' }, text: '买家信用极好' }] },
    shop: { level: 'L2', score: 42, praiseRatio: 100, reviewNum: 5 },
    social: { followers: '11', following: '3' },
    tabs: { item: { number: 6 }, rate: { number: '19' } },
  },
};

test('the seller profile normaliser reads standing, and drops the one field that looks like a city', () => {
  const p = sellerProfileOf(HEAD_PAYLOAD);
  assert.equal(p.display_name, '汴梁资深化镁');
  assert.equal(p.avatar_url, 'https://img.alicdn.com/a.jpg');
  assert.equal(p.city, undefined);
  assert.equal(JSON.stringify(p).includes('上海市'), false, 'ipLocation leaked in somewhere: it is the request origin, not the seller');
  // praiseRatio is a bare 100 here and "100%" on the detail payload; the sign is dropped so the two
  // sources of the same figure compare.
  assert.equal(p.praise_ratio, '100');
  assert.equal(p.listings_count, '6');
  assert.equal(p.ratings_count, '19');
  assert.deepEqual([p.seller_credit, p.buyer_credit], ['卖家信用极好', '买家信用极好']);
  // A tag that is absent and a tag that is false both mean "not verified", and both publish false: an
  // unanswered question must not read as a yes.
  assert.equal(p.verified_zhima, true);
  assert.equal(p.verified_real_name, true);
  assert.equal(sellerProfileOf({ baseInfo: { tags: {} }, module: {} }).verified_real_person, false);
  // SELLER_PROFILE_FIELDS is what seller_profile promises, and it deliberately spans two payloads: the
  // standing half is this function's, and the item-page half is filled from a listing's detail record
  // instead. So the assertion is that each name has exactly one owner -- a name neither returns would
  // mean fields_present / fields_missing describe a field nobody fills.
  const standing = SELLER_PROFILE_FIELDS.filter((f) => !(SELLER_ITEM_PAGE_FIELDS as readonly string[]).includes(f));
  for (const f of standing) assert.ok(f in p, `seller_profile promises ${f}, which this normaliser never returns`);
  for (const f of SELLER_ITEM_PAGE_FIELDS) assert.equal(f in p, false, `${f} comes from the listing's detail record, not from the profile payload`);
  assert.deepEqual([...SELLER_ITEM_PAGE_FIELDS].sort(), ['city', 'items_listed', 'items_sold', 'last_active', 'positive_rate', 'reply_rate_24h', 'tenure_years']);
  // A payload with no module at all is a shape change, and every field comes back blank rather than
  // throwing -- `present()` then names all of them missing, which is the honest report.
  const empty = sellerProfileOf({});
  assert.deepEqual(SELLER_PROFILE_FIELDS.filter((f) => empty[f] !== undefined && empty[f] !== '' && empty[f] !== false), []);
  assert.deepEqual(sellerProfileOf(null).display_name, '');
});

test('the seller listing normaliser reads this endpoint\'s card, not the feed card\'s', () => {
  // A real `mtop.idle.web.xyh.item.list` card. Two things here are not what the feed normaliser
  // expects: `detailUrl` is a `fleamarket://` deep link no browser can open, and the want count is
  // prose in the label strip rather than a number in an attributeMap.
  const cards = sellerListings({ cardList: [{ cardType: 1003, cardData: {
    id: '1045171414271', title: '专柜入手，穿过几次', detailUrl: 'fleamarket://awesome_detail?itemId=1045171414271', categoryId: '50106003',
    detailParams: { itemId: '1045171414271', title: '专柜入手，穿过几次', soldPrice: '1999', picUrl: 'http://img.alicdn.com/i4/a.jpg' },
    priceInfo: { preText: '¥', price: '1999' },
    itemLabelDataVO: { labelData: { r1: { tagList: [{ data: { content: '验货宝' } }] }, r3: { tagList: [{ data: { content: '2人想要' } }] } } },
  } }], totalCount: 0, nextPage: false });
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], { item_id: '1045171414271', title: '专柜入手，穿过几次', price: '1999', category_id: '50106003', want_count: '2', tags: ['验货宝', '2人想要'], image_urls: ['https://img.alicdn.com/i4/a.jpg'], url: 'https://www.goofish.com/item?id=1045171414271' });
  // 万 is read as the multiplier it is: "1.2万人想要" is 12,000 people, not 1.
  assert.equal(sellerListings({ cardList: [{ cardData: { detailParams: { itemId: '9' }, itemLabelDataVO: { labelData: { r3: { tagList: [{ data: { content: '1.2万人想要' } }] } } } } }] })[0].want_count, '12000');
  // No want label at all is an empty string, never a 0: 0 and "not reported" are different facts and
  // this server never conflates them.
  assert.equal(sellerListings({ cardList: [{ cardData: { detailParams: { itemId: '9' } } }] })[0].want_count, '');
  // The id is in `detailParams.itemId` and on the card itself; a card with neither is dropped rather
  // than published without one.
  assert.equal(sellerListings({ cardList: [{ cardData: { title: 'x' } }] }).length, 0);
  assert.equal(sellerListings({ cardList: [{ cardData: { id: '77', title: 'x' } }] })[0].item_id, '77');
  // Neither an absent card list nor a non-array one throws: an empty shop is an answer.
  assert.deepEqual(sellerListings({ cardList: [] }), []);
  assert.deepEqual(sellerListings({}), []);
  assert.deepEqual(sellerListings(null), []);
  // `priceInfo.price` is the fallback when soldPrice is gone, and `picInfo.picUrl` the fallback for the
  // photo -- both https-normalised, because the payload carries http.
  const alt = sellerListings({ cardList: [{ cardData: { id: '5', priceInfo: { price: '42' }, picInfo: { picUrl: 'http://img.alicdn.com/p.jpg' } } }] })[0];
  assert.deepEqual([alt.price, alt.image_urls], ['42', ['https://img.alicdn.com/p.jpg']]);
});
