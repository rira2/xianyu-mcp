/**
 * The tools, driven by a fake session. No network, no browser.
 *
 * The fake is duck-typed and dispatches on which in-page script was passed to
 * `evaluate`, keyed per script, so a test cannot satisfy one tool with another's payload.
 * What is pinned here is behaviour an invariant scan cannot see: the rail is never
 * returned as results, the budgets stop, and a wrong listing is refused rather than
 * reported. The two navigation tests at the bottom are the exception to all of that --
 * they drop the fake session and drive the real `Session` against a fake Page, because a
 * fake that calls `ensureGoofishUrl` itself only proves the fake is careful.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOT_URL, DETAIL_POOL_MAX, exclusive, HOME, reloadFresh, Session, setSession } from '../src/browser.ts';
import { BrowserError, DetailUnavailableError, GatedError, NavigationError, ParseError, SearchUnavailableError, XianyuError } from '../src/errors.ts';
import { FEED_NORMALIZE_JS, ITEM_SCRAPE_JS, MTOP_READY_JS, PAGER_CLICK_JS, SCRAPE_CARDS_JS, SEARCH_INPUT_JS, SEARCH_STATE_JS } from '../src/extract.ts';
import { budget, fanoutSize, ITEM_FIELDS, resetCardCache, TOOLS } from '../src/tools.ts';
import { reset as resetCaches } from '../src/cache.ts';
import { z } from 'zod';

const run = (name: string) => {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, `no tool named ${name}`);
  return t.run;
};

/** A stand-in for the network tap on a page. `feed` hands back each reply once, in order, so a test
 *  can drive the two tools that now read the page's own mtop replies -- `mtop: { detail: {...} }`
 *  makes item_view answer from `mtop.taobao.idle.pc.detail`, `mtop: { search: {...} }` does the same
 *  for search_items -- and can hand back a refusal (`{ ret: 'RGV587_ERROR' }`) as readily as a result. */
const makeTap = (feed: Record<string, any[]> = {}) => {
  const left: Record<string, any[]> = { ...feed };
  return {
    record: () => {},
    // No-op on purpose. The seed models a reply the page is about to make, not a backlog of ones it
    // has already made, and the code calls `clear()` immediately before it provokes the next call --
    // so clearing here would throw away the reply the test is trying to hand over.
    clear: () => {},
    peek: (api: string) => { const l = left[api] ?? []; return l.length ? l[l.length - 1] : null; },
    take: async (api: string) => { const l = left[api] ?? []; return l.length ? l.shift() : null; },
  };
};
const ok = (data: any) => ({ ret: 'SUCCESS::调用成功', ok: true, data });
const refused = (ret: string) => ({ ret, ok: false, data: null });

/** Payloads are keyed by in-page script. `sleepMs` makes the fake's waits cost real time, and `hijack`
 *  moves the page off goofish to that URL: at `hijackAfter: 'open'`, on the first tick after `open`
 *  resolves -- after `open`'s own allowlist check, before the caller's first read, the window the
 *  reviewer read a lookalike host off-site in. At `'read'`, on the first wait *after* a read, which is
 *  item_view's 6s readiness poll and the second read site. */
const makeSession = (payloads: { cards?: any[]; item?: any[]; scrape?: any[]; search?: any; swallow?: number; mtop?: Record<string, any[]>; poolMs?: number; poolSilent?: boolean } = {}, raw: any = {}, sleepMs = 0, hijack = '', hijackAfter: 'open' | 'read' = 'open') => {
  const queues: Record<any, any[]> = { [FEED_NORMALIZE_JS as any]: [...(payloads.cards ?? [])], [ITEM_SCRAPE_JS as any]: [...(payloads.item ?? [])], [SCRAPE_CARDS_JS as any]: [...(payloads.scrape ?? [])] };
  // The searchbox, as a real page holds it: mounted or not, with the keys that have landed so far.
  const search = { mounted: 'search' in payloads ? payloads.search !== null : true, value: '' };
  let at = HOME, reads = 0;
  const page: any = {
    url: () => { reads++; return at; },
    waitForTimeout: async () => { if (hijack && hijackAfter === 'read' && reads > 0) at = hijack; if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs)); },
    goto: async (u: string) => { at = u; search.value = ''; },
    // Only what typeSearch needs: the two in-page reads and the two key actions. `keyboard.type`
    // truncates at `swallow` characters to reproduce the SPA eating a burst across a re-render.
    keyboard: {
      type: async (text: string) => { search.value = payloads.swallow ? text.slice(0, payloads.swallow) : text; },
      press: async (key: string) => { if (key === 'Enter' && search.value) at = `${HOME}search?q=${encodeURIComponent(search.value)}`; },
    },
    evaluate: async (fn: any, arg: any) => {
      if (fn === MTOP_READY_JS) return 'ready';
      if (fn === SEARCH_INPUT_JS) return search.mounted
        ? { found: true, focused: true, value: search.value, inputs: 1, chars: 1200, path: '/' }
        : { found: false, inputs: 0, chars: 512, path: '/', value: '' };
      if (fn === PAGER_CLICK_JS) { s.pagers.push(String(arg.page)); return { ok: s.max_page >= Number(arg.page), on_page: arg.page }; }
      // The real normaliser, on the rows the tool actually passed. A canned queue cannot express this:
      // how many cards come out of the pool depends on how many pages were walked, which is the thing
      // under test.
      if (fn === FEED_NORMALIZE_JS && s.runRealNormalizer) return FEED_NORMALIZE_JS(arg);
      if (fn === SEARCH_STATE_JS) {
        const onSearch = at.includes('/search');
        return { typed: search.value, path: onSearch ? '/search' : '/', on_search: onSearch, cards: onSearch ? 30 : 0 };
      }
      const q = queues[fn];
      if (!q) return null;   // the gallery nudge, and anything not a scraper
      return q.length > 1 ? q.shift() : q[0];
    },
  };
  const s: any = {
    launches: 0, opened: [] as string[], specs: [] as any[][], raw, search, pagers: [] as string[], max_page: 99, runRealNormalizer: false,
    ensureReady: async () => page,
    domReady: async () => page,
    // The dom page is a separate page from the api page, so the four mtop-only tools never wait on a
    // search; the fake keeps one `page` for both because nothing under test depends on them differing.
    apiTap: makeTap(), domTap: makeTap(payloads.mtop),
    // NOT the real guard: this stand-in records what a tool asked for and loads it, nothing more.
    // The real `Session.open`, and the `ensureGoofishUrl` it runs before and after every goto, is
    // exercised for real in the two navigation tests below, against a fake Page.
    open: async (u: string) => { s.opened.push(u); at = u; search.value = ''; if (hijack && hijackAfter === 'open') queueMicrotask(() => { at = hijack; }); return page; },
    // The bounded detail pool, as the session hands it out: one page and one tap per slot, created on
    // demand. The tap answers about whatever listing its OWN page was last asked to load, which is what
    // a real page's own detail call does -- and is what makes two concurrent reads provably
    // independent rather than two consumers of one FIFO queue. `poolMs` costs the load real time, so a
    // test can tell a fan-out from a serial walk by whether the load windows overlap. `poolSilent`
    // refuses every pool page, which is the throttled-site arm.
    pool: [] as any[], poolLoads: [] as { slot: number; url: string; from: number; to: number }[],
    fanoutSurface: async (slot: number, u: string) => {
      if (!Number.isInteger(slot) || slot < 0 || slot >= DETAIL_POOL_MAX) throw new BrowserError(`detail fan-out slot ${slot} does not exist`);
      const held = s.pool[slot] ?? (s.pool[slot] = { page: poolPage(payloads.poolMs ?? 0), tap: null as any });
      if (!held.tap) held.tap = { record: () => {}, clear: () => {}, take: async (api: string) => (api !== 'mtop.taobao.idle.pc.detail' || payloads.poolSilent ? null : detailReply(String(held.page.url().match(/[?&]id=(\d+)/)?.[1] ?? ''))) };
      const load = { slot, url: u, from: Date.now(), to: 0 };
      s.poolLoads.push(load);
      await held.page.goto(u);
      if (payloads.poolMs) await new Promise((r) => setTimeout(r, payloads.poolMs));
      load.to = Date.now();
      return { page: held.page, tap: held.tap, load: { url: held.page.url(), declined: '', ms: load.to - load.from } };
    },
    call: async (spec: any) => { s.specs.push(spec); return s.raw; },
  };
  return s;
};

/** A page for one detail-fan-out slot: its own document, nothing else. A slot is never asked to
 *  render a search or to walk a pager, so the whole of a real page's surface is not needed -- but it is
 *  a separate object per slot, so a test can tell which page a load landed on and two concurrent
 *  reads cannot move each other. `ms` is what makes the fake cost real time, which is how a fan-out is
 *  told apart from a serial walk. */
const poolPage = (ms: number) => {
  let at = HOME;
  const page: any = {
    url: () => at,
    waitForTimeout: async () => { if (ms) await new Promise((r) => setTimeout(r, ms)); },
    goto: async (u: string) => { at = u; },
    evaluate: async (fn: any) => (fn === MTOP_READY_JS ? 'ready' : null),
  };
  return page;
};

/** A `mtop.taobao.idle.pc.detail` reply for one listing, in the shape the page's own call returns --
 *  which is the shape the pool's tap answers about whatever that page was asked to load. */
const detailReply = (id: string) => ok({ itemDO: { itemId: id, title: `详情 ${id}`, soldPrice: '123', wantCnt: 4, browseCnt: 900, desc: '成色好，功能正常' }, sellerDO: { nick: '卖家', city: '北京', hasSoldNumInteger: 12, userRegDay: 730, newGoodRatioRate: '99%' } });

/**
 * A Page fake for the *real* Session, which does touch everything on this object: url, goto,
 * reload, isClosed, waitForTimeout and evaluate. `land` is where a navigation actually ends up, so a
 * redirect off goofish can be simulated, and `start` is what the page is parked on beforehand.
 */
const drivenPage = (opts: { land?: (u: string) => string; start?: string; queues?: Record<any, any[]> } = {}) => {
  let at = opts.start ?? HOME;
  const page: any = {
    url: () => at,
    isClosed: () => false,
    // The mtop tap a real Session bolts onto every page it opens. It records replies by subscribing
    // to responses; this fake has no responses, so the subscription is the whole of its job here.
    on: () => {},
    reload: async () => {},
    waitForTimeout: async () => {},
    goto: async (u: string) => { page.calls.push(u); at = opts.land ? opts.land(u) : u; },
    evaluate: async (fn: any) => {
      if (fn === MTOP_READY_JS) return 'ready';
      const q = opts.queues?.[fn];
      return q ? (q.length > 1 ? q.shift() : q[0]) : null;
    },
    calls: [] as string[],
  };
  return page;
};
const use = (s: any) => { setSession(s as Session); return s; };

/** A session whose *real* card scraper runs, against a synthetic document. How many cards a tool asks
 *  that scraper for is invisible to a canned payload -- the fake hands over the same handful whatever
 *  the limit is -- so the over-ask fix can only be pinned by executing it. `dialog` puts goofish's
 *  anonymous login overlay on that document: a mask, the passport iframe, and four close controls
 *  wired to a tripwire, so a test can tell whether a read clicked its way out of it. */
const domSession = (titles: string[], at = HOME, dialog = false) => {
  const g = globalThis as any;
  const clicks: string[] = [];
  const close = (label: string) => ({ getBoundingClientRect: () => ({ width: 20, height: 20 }), click: () => clicks.push(label) });
  const overlay: Record<string, any[]> = dialog
    ? { '#baxia-dialog-close': [close('close')], '[class*="closeIcon"]': [close('icon')], '[class*="closeIconBg"]': [close('iconBg')], '[class*="dialog-close"]': [close('dclose')], '[class*="modal-close"]': [close('mclose')], '.ant-modal-mask': [{ getBoundingClientRect: () => ({ width: 1440, height: 900 }) }], 'iframe': [{ src: 'https://passport.goofish.com/iframe' }] }
    : {};
  // A real <input>, so SEARCH_INPUT_JS -- the one in-page function that finds, marks and focuses it --
  // runs for real here rather than being mocked past. The geometry it selects on is >=100px wide in
  // the top 400px, so the fixture has to be the right size or the test measures a search tool aimed at
  // a document with no search box.
  const input: any = { value: '', attrs: {} as Record<string, string>, getBoundingClientRect: () => ({ width: 320, height: 40, top: 60 }), setAttribute(this: any, k: string, v: string) { this.attrs[k] = v; }, focus: () => {}, getAttribute(this: any, k: string) { return this.attrs[k] ?? null; } };
  const cardEls: any[] = titles.map((t, i) => ({
    href: `https://www.goofish.com/item?id=${100 + i}`, innerText: `${t} ¥9`, getAttribute: () => null,
    // the price and seller cells are one level deeper than the title cell, as they are in a real card
    querySelector: (sel: string) => (sel.includes('price') || sel.includes('seller') ? { querySelector: () => ({ textContent: '' }) } : { textContent: t }),
    querySelectorAll: () => [],
  }));
  g.document = {
    body: { innerText: dialog ? '区域 1/50  登录后可查看更多\n联想 X220' : '' },
    activeElement: input,
    querySelector: (s: string): any => (s === 'input' ? input : overlay[s]?.[0] ?? (input.attrs['data-xianyu-search'] ? input : null)),
    querySelectorAll: (sel: string) => (sel === 'input' ? [input] : overlay[sel] ?? (sel === 'a[href*="/item?id="]' ? cardEls : [])),
  };
  // The in-page scripts read `location` and `window` off globalThis and throw without them; a missing
  // global is a TypeError that reads like a product bug, which is how a real one hides.
  g.window = { innerHeight: 900, innerWidth: 1440 };
  let here = at;
  g.location = { get pathname() { return new URL(here).pathname; }, get search() { return new URL(here).search; }, href: here };
  // The typed query really navigates, so SEARCH_STATE_JS answers on_search: true -- otherwise the tool
  // would report a refusal and the test would be measuring the wrong thing entirely.
  const page: any = {
    url: () => here,
    waitForTimeout: async () => {},
    evaluate: async (fn: any, arg: any) => fn(arg),
    keyboard: { type: async (t: string) => { input.value += t; }, press: async (k: string) => { if (k === 'Enter' && input.value) here = `${HOME}search?q=${encodeURIComponent(input.value)}`; } },
  };
  const s: any = { launches: 0, opened: [] as string[], specs: [] as any[][], raw: {}, ensureReady: async () => page, domReady: async () => page,
    apiTap: makeTap(), domTap: makeTap(), open: async (u: string) => { s.opened.push(u); here = u; input.value = ''; return page; }, call: async () => ({}), clicks };
  return use(s);
};

/** A real Session with a fake page bolted in, so `Session.open` -- and the allowlist check it runs
 *  around every goto -- is the thing under test. No Chromium is launched. */
const realSession = (opts: Parameters<typeof drivenPage>[0] = {}) => {
  const s = new Session(), page = drivenPage(opts);
  (s as any).apiPage = page; (s as any).domPage = page;
  use(s);
  return { s, page };
};
// The search-card cache and the TTL cache are both module state that outlives a call, so they are
// cleared between tests the same way the env budget is: a test that seeded one would otherwise have
// the next item_view or search_items answered from it -- and, worse, would stop exercising the
// refusal paths, since a cached listing never reaches them.
test.afterEach(() => { setSession(null); resetCardCache(); resetCaches(); for (const g of ['document', 'location', 'window']) delete (globalThis as any)[g]; for (const k of ['SEARCH', 'ITEM_VIEW', 'RECOMMENDATIONS']) delete process.env[`XIANYU_${k}_BUDGET_S`]; delete process.env.XIANYU_SEARCH_MAX_ITEMS; delete process.env.XIANYU_DETAIL_FANOUT; });

const cards = (ids: string[]) => ({ ok: true, ret: 'SUCCESS::调用成功', data: { cardList: ids.map((id) => ({ cardData: { itemId: id, title: `t${id}`, soldPrice: '5' } })) } });
const listed = (ids: string[]) => ids.map((id) => ({ item_id: id, title: `t${id}`, price: '5', city: '杭州', seller: 'a', want_count: '1', image_urls: [], url: `https://www.goofish.com/item?id=${id}` }));

const RENDERED = { detail_rendered: true, page_item_id: '42', title: '男士羊毛呢大衣', price: '1999', want_count: '2', browse_count: '110', description: '专柜入手。', seller: '汴梁', seller_tenure_years: '4', seller_items_sold: '27', seller_positive_rate: '100', image_urls: ['https://img.alicdn.com/x.jpg'], head_preview: '...', reco_anchors: 30, image_candidates: 4 };
const UNRENDERED = { detail_rendered: false, head_preview: '阿里巴巴集团 淘宝 天猫' };
/** A `mtop.taobao.idlemtopsearch.pc.search` reply, in the shape the page's own call returns: each
 *  result's card is split between `clickParam.args` (the price, the want count, the ids) and
 *  `exContent` (the title, the picture, the city). `cards` is [title, itemId, price, city, wantNum].
 *
 *  `searchCase` returns that payload together with the rows the *real* feed normaliser produces from
 *  it, so a test's `cards:` fake and its mtop reply describe the same thirty listings rather than two
 *  fixtures that happen to agree. */
const searchReply = (keyword: string, cards: string[][]) => ({
  resultList: cards.map(([title, itemId, price, area, wantNum], i) => ({
    data: { item: { main: {
      clickParam: { args: { item_id: itemId, price, wantNum, keyword, index: String(i), page: '1', cCatId: '126854525', catId: '50025387', seller_id: 'jRM3w0UnqSvHrFFMpqPdsQ==', publishTime: '1784640276000' } },
      exContent: { area, detailParams: { itemId, title, soldPrice: price, userNick: '卖家' + i, picUrl: `https://img.alicdn.com/bao/uploaded/i1/${itemId}.jpg`, isVideo: 'false' } },
    } } },
    style: 'card', type: 'item',
  })),
});
const searchCase = (keyword: string, cards: string[][]) => ({
  mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [ok(searchReply(keyword, cards))] },
  rows: cards.map(([title, itemId, price, area, wantNum]) => ({
    item_id: itemId, title, price, city: area, want_count: wantNum, seller: '卖家', image_urls: [`https://img.alicdn.com/bao/uploaded/i1/${itemId}.jpg`],
    url: `https://www.goofish.com/item?id=${itemId}`,
  })),
});
const NEVER_RENDERED = { rendered: false, query_hits: 0, cards_scanned: 0, rail: '', says_no_results: false, blocked: false, text_preview: '阿里巴巴集团 淘宝 天猫', items: [] };
// What goofish serves when it declines: unrelated cards under the 猜你喜欢 rail.
const SEARCH_RAIL = { rendered: true, query_hits: 0, cards_scanned: 40, rail: '猜你喜欢', says_no_results: true, text_preview: '小闲鱼没有找到你想要的宝贝~ 猜你喜欢', items: [{ item_id: '900', title: '木瓜丝广西特产', price: '9', condition: '', brand: '', city: '南宁', url: 'https://www.goofish.com/item?id=900', matches_query: false }] };

test('browse_feed returns ranked, deduped, trimmed listings and an honest per-page report', async () => {
  const s = use(makeSession({ cards: [listed(['1', '2', '3'])] }, { p1: cards(['1', '2']), p2: cards(['2', '3']) }));
  const out = await run('browse_feed')({ pages: 2, limit: 2 });
  assert.equal(s.opened.length, 0, 'the mtop-only path must not navigate');
  assert.deepEqual(out.requested_pages, [1, 2]);
  assert.deepEqual(out.page_reports, [{ page: 1, ok: true, cards: 2 }, { page: 2, ok: true, cards: 2 }]);
  assert.equal(out.account_required, false);
  assert.equal(out.unique_items, 3);
  assert.equal(out.count, 2);
  assert.deepEqual(out.items.map((i: any) => [i.item_id, i.rank]), [['1', 1], ['2', 2]]);
  // the feed call carries a page number and nothing that could be a credential
  assert.deepEqual(s.specs[0][0], ['p1', 'mtop.taobao.idlehome.home.webpc.feed', { pageNumber: 1 }]);
});

test('browse_feed called directly clamps a garbage page number to 1 and pages to the default of 1', async () => {
  const s = use(makeSession({ cards: [listed(['1'])] }, { p1: cards(['1']) }));
  const out = await run('browse_feed')({ page_number: 'abc' as any, pages: -5 as any });
  assert.deepEqual(out.requested_pages, [1]);
  assert.deepEqual(s.specs[0][0][2], { pageNumber: 1 });
  assert.equal(s.specs[0].length, 1, 'pages defaulted to 1');
});

test('a feed refusal is a GatedError naming the real ret; a shape change is a ParseError naming the keys', async () => {
  use(makeSession({ cards: [[]] }, { p1: { ok: false, ret: 'RGV587_ERROR::SM::挤爆啦' } }));
  await assert.rejects(run('browse_feed')({}), (e: any) => e instanceof GatedError && /RGV587/.test(e.message));
  use(makeSession({ cards: [[]] }, { p1: { ok: true, ret: 'SUCCESS', data: { cardList: [{ brandNew: 1 }] } } }));
  await assert.rejects(run('browse_feed')({}), (e: any) => e instanceof ParseError && /brandNew/.test(e.message));
  // one refused page does not throw away the others, and it all went out in one mtop batch
  // a non-list `cardList` used to escape as a raw TypeError from the spread, published as an
  // error_type outside the taxonomy; the empty-list path already says what went wrong
  use(makeSession({ cards: [[]] }, { p1: { ok: true, ret: 'SUCCESS', data: { cardList: { 0: { brandNew: 1 } } } } }));
  await assert.rejects(run('browse_feed')({}), (e: any) => e.constructor.name === 'ParseError' && !/cardList may not be/.test(e.message));
  const s = use(makeSession({ cards: [listed(['1'])] }, { p1: cards(['1']), p2: { ok: false, ret: 'RGV587_ERROR' } }));
  const out = await run('browse_feed')({ pages: 2 });
  assert.equal(out.unique_items, 1);
  assert.deepEqual(out.page_reports[1], { page: 2, ok: false, ret: 'RGV587_ERROR' });
  assert.equal(s.specs.length, 1);
});

test('search_items never hands back the recommendation rail as results', async () => {
  const s = use(makeSession({ scrape: [SEARCH_RAIL, SEARCH_RAIL, SEARCH_RAIL] }));
  await assert.rejects(run('search_items')({ query: 'x220', attempts: 3 }), (e: any) => {
    assert.ok(e instanceof SearchUnavailableError);
    assert.equal(e.message.includes('木瓜丝'), false, 'a rail card title leaked into the refusal');
    // The refusal must name the rail and the evidence, not the mechanism that produced it. The old
    // wording ("declined per page load") described direct-URL navigation, which the searchbox rewrite
    // replaced; what still has to be true is that the rail was seen, and refused.
    assert.match(e.message, /"rail":"猜你喜欢"/);
    return true;
  });
  assert.equal(s.opened.length, 3, 'it retried with fresh loads before giving up');
  await assert.rejects(run('search_items')({ query: '   ' }), XianyuError);

  // A markerless page of 40 cards with a short numeric query, where one title contains "1" by
  // accident: `hits > 0` accepted that, so an agent was told "40 results for 1". The denominator is
  // every card on the page, not the cards we kept, and 20% of 40 is 8. (A *dense* incidental hit
  // count -- 12 of 40 -- still passes a fraction test; what catches that one is the rail marker it
  // was under, which is why both scrapers now take the same marker list.)
  const railish = (hits: number, cards: number) => ({ rendered: true, cards_scanned: cards, rail: '', says_no_results: false, text_preview: '小闲鱼', query_hits: hits, items: Array.from({ length: cards }, (_, i) => ({ item_id: String(900 + i), title: i < hits ? 'iPhone 15 Pro 1TB' : '木瓜丝 广西特产', price: '9', condition: '', brand: '', city: '南宁', url: 'u', matches_query: i < hits })) });
  const weak = use(makeSession({ scrape: [railish(1, 40)] }));
  await assert.rejects(run('search_items')({ query: '1', attempts: 1 }), (e: any) => e instanceof SearchUnavailableError && /"min_query_hits":8/.test(e.message));
  assert.equal(weak.opened.length, 1);
  // and the same page is accepted once enough of it really matches
  const strong = use(makeSession({ scrape: [railish(20, 40)] }));
  assert.equal((await run('search_items')({ query: '1', attempts: 1 })).count, 20);
  assert.equal(strong.opened.length, 1);
});

test('search_items accepts a later load that serves real matches, counts only the matches, and logs the decline that came first', async () => {
  // 3 of 4 cards on this page carry the query; the fourth is a card that merely got scraped.
  const page = { rendered: true, cards_scanned: 4, rail: '', says_no_results: false, text_preview: 'x220', query_hits: 3, token_hits: 3, items: [
    { item_id: '1', title: '联想X220 电池', price: '300', condition: '', brand: '', city: '北京', url: 'u1', matches_query: true },
    { item_id: '2', title: 'X220 屏幕总成', price: '200', condition: '', brand: '', city: '北京', url: 'u2', matches_query: true },
    { item_id: '3', title: 'x220 主板 2620m', price: '180', condition: '', brand: '', city: '上海', url: 'u3', matches_query: true },
    { item_id: '4', title: 'ThinkPad 键盘', price: '50', condition: '', brand: '', city: '广州', url: 'u4', matches_query: false }] };
  use(makeSession({ scrape: [SEARCH_RAIL, page] }));
  const out = await run('search_items')({ query: 'x220', attempts: 2 });
  assert.equal(out.source, 'search_page_dom');
  // count is a match count, so an agent cannot report "4 X220 listings" for 3
  assert.deepEqual([out.count, out.query_hits, out.items.length], [3, 3, 3]);
  assert.deepEqual([out.scraped_cards, out.non_matching_count, out.min_query_hits], [4, 1, 1]);
  assert.ok(out.items.every((i: any) => i.matches_query));
  // and no card calls itself a recommendation
  assert.equal('source' in out.items[0], false);
  // The declined first attempt is in the log. Index 0 is the typed-search step rather than the
  // scrape, since the searchbox path logs that too; the scrape entry is the one carrying `rendered`.
  const declined = out.attempt_log.find((e: any) => 'rendered' in e);
  assert.deepEqual({ rendered: declined.rendered, rail: declined.rail, query_hits: declined.query_hits }, { rendered: true, rail: '猜你喜欢', query_hits: 0 });
  assert.equal(out.attempt_log[0].via, 'searchbox', 'the first attempt typed the query rather than navigating to a URL');
});

test('search_items over-asks the scraper, so leading non-matching cards cannot fake an empty result set', async () => {
  // 200 cards, the first five unrelated, limit 5. The collector used to stop at `limit` and the tool
  // then filtered to matches, so every collected card was discarded and the tool reported a
  // successful, empty, self-contradicting answer next to query_hits 195 and scraped_cards 200.
  const mixed = (n: number, lead: number) => Array.from({ length: n }, (_, i) => (i < lead ? '木瓜丝广西特产' : `联想 X220 键盘 ${i}`));
  domSession(mixed(200, 5));
  const out = await run('search_items')({ query: 'x220', limit: 5, attempts: 1 });
  assert.deepEqual([out.count, out.items.length, out.query_hits, out.scraped_cards, out.min_query_hits], [5, 5, 195, 200, 40]);
  assert.ok(out.items.every((i: any) => i.matches_query && /X220/.test(i.title)), 'only real matches came back');
  assert.deepEqual(out.items.map((i: any) => i.rank), [1, 2, 3, 4, 5]);
  // limit 1 on a mildly mixed page, which the same bug emptied
  domSession(mixed(12, 3));
  assert.deepEqual(Object.values(await run('search_items')({ query: 'x220', limit: 1, attempts: 1 })).filter((v) => typeof v === 'number').includes(1), true);

  // A pasted query with a double space matched nothing at all before the query was whitespace-
  // collapsed, which is a refusal on a page full of real matches.
  domSession(Array.from({ length: 10 }, (_, i) => `联想 X220 键盘 ${i}`));
  const spaced = await run('search_items')({ query: 'x220  键盘', limit: 3, attempts: 1 });
  assert.deepEqual([spaced.count, spaced.query], [3, 'x220 键盘']);

  // A multi-word query whose words all appear but never as one substring. This used to be refused --
  // "the strict guard stands" -- and refusing it is what made the tool useless on this site, where a
  // search for `机械硬盘4t` has 70,146 listings by goofish's own counter and the titles read
  // `西数4T机械硬盘`. All the terms are there; only the searcher's word order is not. Accepted now,
  // and `matched_by` says which rule did it so a caller is not left guessing.
  domSession(Array.from({ length: 8 }, (_, i) => `联想 X220 键盘 ${i}`));
  const reordered = await run('search_items')({ query: '键盘 x220 联想', attempts: 1 });
  assert.equal(reordered.count, 8);
  assert.equal(reordered.query_hits, 0, 'no title carries the phrase');
  assert.equal(reordered.token_hits, 8, 'all eight carry every term');
  assert.equal(reordered.matched_by, 'all_terms', 'and the envelope says the phrase was not the match');

  // ...and the guard still has teeth: a page carrying only some of the terms is a rail, not results.
  domSession(Array.from({ length: 8 }, (_, i) => `机械硬盘 台式机内存条 ${i}`));
  await assert.rejects(run('search_items')({ query: '机械硬盘4t', attempts: 1 }), (e: any) => e instanceof SearchUnavailableError
    && /"query_hits":0/.test(e.message) && /"token_hits":0/.test(e.message) && /"scraped_cards":8/.test(e.message) && /\b1 attempt\(s\)/.test(e.message));
});

test('every DOM read re-checks the URL first, so a page moved off goofish mid-call is refused', async () => {
  // The reviewer's exploit: `open` checks the URL it landed on, then the tool polls for seconds before
  // it reads anything, and the page can be moved off-site in that window. These payloads are all
  // individually acceptable, so only the host can refuse them.
  const EVIL = { rendered: true, cards_scanned: 1, query_hits: 1, token_hits: 1, rail: '', says_no_results: false, text_preview: 'evil', items: [{ item_id: '666', title: '数据来自 evil.com', price: '1', condition: '', brand: '', city: '', url: 'u', matches_query: true }] };
  use(makeSession({ scrape: [EVIL] }));
  assert.equal((await run('search_items')({ query: 'evil', attempts: 1 })).items[0].item_id, '666', 'the payload itself is fine -- it is the host that is not, so the test is not vacuous');
  for (const host of ['https://www.goofish.com.evil.com/', 'https://www.goofish.computer/', 'https://www.goofish.com@evil.com/']) {
    use(makeSession({ scrape: [EVIL] }, {}, 0, host));
    await assert.rejects(run('search_items')({ query: 'evil', attempts: 1 }), (e: any) => e instanceof NavigationError, host);
    // RENDERED on purpose: the page would otherwise be accepted, so only the host can be refusing
    use(makeSession({ item: [RENDERED] }, {}, 0, host));
    await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => e instanceof NavigationError, host);
    // and the second read site: item_view polls for up to 6s between reads, so the swap lands in there
    use(makeSession({ item: [UNRENDERED] }, {}, 0, host, 'read'));
    await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => e instanceof NavigationError, host);
  }
});

test('the budget arithmetic: 45s default, overridable, floored at 5 and capped at 600, garbage falls back', () => {
  assert.equal(budget('SEARCH', 45), 45);
  // anything that is not a whole number of seconds falls back rather than raising, and the ceiling
  // is what stops XIANYU_SEARCH_BUDGET_S=86400 from restoring the hang this function exists to stop
  for (const [raw, want] of [['12', 12], ['1', 5], ['900', 600], ['86400', 600], ['1e3', 600], ['nonsense', 45], ['', 45], ['  ', 45], ['12.5', 45]] as const) {
    process.env.XIANYU_SEARCH_BUDGET_S = raw;
    assert.equal(budget('SEARCH', 45), want, `XIANYU_SEARCH_BUDGET_S=${JSON.stringify(raw)}`);
  }
});

test('search_items reads results out from under the login dialog, and never clicks to get them', async () => {
  // The bug this pins. Measured headed, same URL, one fresh context per arm: with nothing dismissed
  // the cards were in the DOM by t+12s (30 anchors, real X220 matches) *under* the ant-modal-mask and the
  // passport iframe; dismissing at t+6s or t+12s clicked 4 close controls and the result list then
  // never rendered at all, at any subsequent sample, and the 猜你喜欢 rail was served instead. The
  // comment in the source claimed the opposite ("must be closed or the page renders zero cards"), the
  // whole retry design was built on it, and search declined on ~100% of attempts because of it.
  //
  // The dialog is here, with its four close controls wired to a tripwire. The read has to succeed and
  // the tripwire has to stay quiet -- either half alone would miss the failure mode, since a page
  // that clicked its way out is a page whose results we can no longer trust.
  const titles = Array.from({ length: 12 }, (_, i) => `联想 ThinkPad X220 ${i}`);
  const s = domSession(titles, HOME, true);
  const out = await run('search_items')({ query: 'x220', limit: 5, attempts: 1 });
  assert.deepEqual([out.count, out.query_hits, out.scraped_cards], [5, 12, 12]);
  assert.ok(out.items.every((i: any) => i.matches_query && /X220/.test(i.title)), 'the matches came out of the page, not out of a rail');
  assert.equal(out.attempt_log.find((e: any) => 'rendered' in e).blocked, false, 'a page under the dialog is not a risk-control page');
  assert.deepEqual(s.clicks, [], 'the read path clicked the dialog -- the state it used to trigger');

  // The tripwire has teeth: a document whose close controls are the only way its cards appear cannot
  // be satisfied by reading, so a passing result above is not the fixture agreeing with itself.
  assert.equal(domSession([], HOME, true).clicks.length, 0, 'nothing in the fixture clicks by itself');

  // And the same page *is* accepted when there is no dialog at all -- so the dialog is genuinely
  // irrelevant to the outcome, rather than the test passing for some other reason.
  const bare = domSession(titles, HOME, false);
  assert.equal((await run('search_items')({ query: 'x220', limit: 5, attempts: 1 })).count, 5);
  assert.equal(bare.clicks.length, 0);
});

test('a wall-clock budget stops search_items instead of letting it hold the caller', async () => {
  // This one really waits: the page never renders, so the tool polls until its 5s budget
  // (the floor) is spent and then gives up rather than reloading again.
  const s = use(makeSession({ scrape: [NEVER_RENDERED] }, {}, 700));
  process.env.XIANYU_SEARCH_BUDGET_S = '5';
  await assert.rejects(run('search_items')({ query: 'x220', attempts: 10 }), (e: any) => {
    assert.ok(e instanceof SearchUnavailableError);
    // and it does not claim zero attempts after a real page load, which is what the clock-break used
    // to do: it pushed a marker with no `attempt` on it and the count filtered on that field
    // The count and the clock are asserted separately. The old regex ran them together
    // ("1 attempt(s) in 6s"), which only ever held because the elapsed time was interpolated
    // between the two words -- an assertion about message layout, not about the budget stopping it.
    assert.match(e.message, /\b1 attempt\(s\)/);
    assert.match(e.message, /in \d+s/);
    assert.match(e.message, /stopped on: time budget reached/);
    return true;
  });
  assert.equal(s.opened.length, 1, 'it stopped on the clock, not on the attempt count');

  // The same clock has to bind the *page load* failure path. A `continue` past the deadline check
  // meant a network that cannot reach goofish at all ran all ten attempts, and at the real 60s nav
  // timeout that is minutes against a 45s promise.
  const dead = use(makeSession({ scrape: [NEVER_RENDERED] }));
  let opens = 0;
  dead.open = async () => { opens++; await new Promise((r) => setTimeout(r, 700)); throw new BrowserError('net::ERR_ADDRESS_UNREACHABLE'); };
  process.env.XIANYU_SEARCH_BUDGET_S = '5';
  const began = Date.now();
  await assert.rejects(run('search_items')({ query: 'x220', attempts: 10 }), (e: any) => e instanceof SearchUnavailableError && /ERR_ADDRESS_UNREACHABLE/.test(e.message));
  const spent = Date.now() - began;
  assert.ok(opens < 10 && spent < 9000, `${opens} page loads in ${spent}ms: the budget did not bind the load-failure path`);
});

test('item_view answers from the page\'s own detail reply, with the fields the DOM could not reach', async () => {
  // This is the reply `mtop.taobao.idle.pc.detail` returns when the *page* makes the call, captured
  // off the wire. The DOM route could not produce a title at all (measured: empty on 6 of 6 live
  // listings) and returned goofish's promo banners as the gallery.
  const s = use(makeSession({ item: [UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [ok({
    itemDO: {
      itemId: '42', title: '腾亚40C瓦斯钉抢，功能正常使用', soldPrice: '366', originalPrice: '0',
      desc: '刚保养清洗干净，收到就可以用', wantCnt: 1, browseCnt: 34, collectCnt: 2, quantity: 1,
      itemStatusStr: '在线', transportFee: '0.00',
      imageInfos: [{ url: 'http://img.alicdn.com/bao/uploaded/i1/4197327154/a.jpg' }, { url: 'http://img.alicdn.com/bao/uploaded/i1/4197327154/b.jpg' }],
      cpvLabels: [{ propertyName: '品牌', valueName: 'Toua/腾亚' }, { propertyName: '成色', valueName: '明显使用痕迹' }, { propertyName: '已用年限', valueName: '1年(含)-3年(不含)' }],
    },
    sellerDO: { nick: '今生有缘xy', city: '台州', userRegDay: 2256, hasSoldNumInteger: 369, itemCount: 655, newGoodRatioRate: '80%', replyRatio24h: '97%', signature: '二手电动工具，', zhimaAuth: true, portraitUrl: 'http://gtms03.alicdn.com/a.png', lastVisitTime: '3小时前来过' },
  })] } }));
  const out = await run('item_view')({ item_id: '42' });
  assert.equal(out.source, 'item_detail_api');
  assert.equal(out.title, '腾亚40C瓦斯钉抢，功能正常使用', 'the field the DOM could never fill');
  assert.equal(out.price, '366');
  assert.equal(out.want_count, '1'); assert.equal(out.browse_count, '34');
  assert.equal(out.description, '刚保养清洗干净，收到就可以用');
  assert.equal(out.seller, '今生有缘xy');
  assert.equal(out.seller_tenure_years, '6', 'userRegDay is in days: 2256 days is 6 years');
  assert.equal(out.seller_items_sold, '369');
  assert.equal(out.seller_positive_rate, '80');
  assert.deepEqual(out.fields_missing, [], 'every promised field is present on this payload');
  // the seller's own photos, https-normalised, not a promo banner
  assert.deepEqual(out.image_urls, ['https://img.alicdn.com/bao/uploaded/i1/4197327154/a.jpg', 'https://img.alicdn.com/bao/uploaded/i1/4197327154/b.jpg']);
  // and the fifteen-odd fields the DOM never exposed
  assert.equal(out.brand, 'Toua/腾亚');
  assert.equal(out.condition, '明显使用痕迹');
  assert.equal(out.used_years, '1年(含)-3年(不含)');
  assert.equal(out.seller_city, '台州');
  assert.equal(out.seller_signature, '二手电动工具，');
  assert.equal(out.seller_reply_rate_24h, '97');
  assert.equal(out.seller_items_listed, '655');
  assert.equal(out.collect_count, '2');
  assert.equal(out.seller_zhima_verified, true);
  assert.equal(out.seller_avatar, 'https://gtms03.alicdn.com/a.png');
  assert.equal(out.item_status, '在线');
  assert.deepEqual(Object.entries(out.attributes).map(([k, v]) => `${k}=${v}`), ['品牌=Toua/腾亚', '成色=明显使用痕迹', '已用年限=1年(含)-3年(不含)']);
  // and the same listing as types, beside those strings rather than instead of them
  assert.deepEqual(out.typed, {
    price_amount: 366, want_count: 1, view_count: 34, collect_count: 2, condition: '明显使用痕迹',
    published_at: null, updated_at: null, location: { province: null, city: '台州' },
    shipping: { fee: 0, free_shipping: true },
    seller_stats: { tenure_years: 6, items_sold: 369, positive_rate: 80, reply_rate_24h: 97, zhima_verified: true },
  });
  assert.deepEqual(out.missing, ['published_at', 'updated_at', 'location.province'],
    'the three the payload genuinely has no value for, and nothing else');
  assert.equal(out.price, '366', 'the flat field is still the string every existing caller reads');
  // the page was still loaded: that is where the call comes from
  assert.deepEqual(s.opened, ['https://www.goofish.com/item?id=42']);
});

test('every listing route publishes the same typed block, and names what its own source lacked', async () => {
  // The point of the block being one function: a caller must not have to learn a different schema per
  // tool. These are the thinnest and the richest routes in this file, and the keys are identical --
  // only the values differ, which is the honest difference between what goofish told us.
  const feed = use(makeSession({ cards: [listed(['1', '2'])] }, { p1: cards(['1', '2']) }));
  const fromFeed = (await run('browse_feed')({ page_number: 1, pages: 1 })).items[0];
  assert.deepEqual(Object.keys(fromFeed.typed), ['price_amount', 'want_count', 'view_count', 'collect_count', 'condition', 'published_at', 'updated_at', 'location', 'shipping', 'seller_stats']);
  assert.deepEqual(fromFeed.typed, { price_amount: 5, want_count: 1, view_count: null, collect_count: null, condition: null,
    published_at: null, updated_at: null, location: { province: null, city: '杭州' }, shipping: null, seller_stats: null });
  // a homepage feed card names no province and quotes no fee; saying so by name is the answer, and
  // guessing either from the city or from the tag strip would be a fact this server never read
  assert.deepEqual(fromFeed.missing, ['view_count', 'collect_count', 'condition', 'published_at', 'updated_at', 'location.province', 'shipping', 'seller_stats']);
  assert.equal(fromFeed.price, '5', 'and the string fields are exactly what they were before the block existed');

  use(makeSession({ item: [RENDERED] }));
  const fromDom = await run('item_view')({ item_id: '42' });
  assert.deepEqual(Object.keys(fromDom.typed), Object.keys(fromFeed.typed), 'the block does not change shape with the route');
  // The rendered item page prints a title, a price, the counts and the seller, and no epoch, no
  // province and no fee. So most of the block is null here, and `missing` says which -- which is a
  // more useful answer than the thinner listing this used to publish.
  assert.deepEqual(fromDom.typed, { price_amount: 1999, want_count: 2, view_count: 110, collect_count: null, condition: null,
    published_at: null, updated_at: null, location: null, shipping: null,
    seller_stats: { tenure_years: 4, items_sold: 27, positive_rate: 100, reply_rate_24h: null, zhima_verified: null } });
  assert.deepEqual(fromDom.missing, ['collect_count', 'condition', 'published_at', 'updated_at', 'location', 'shipping', 'seller_stats.reply_rate_24h', 'seller_stats.zhima_verified']);
  // ... and the pre-existing honesty contract is untouched by any of it
  assert.deepEqual(fromDom.fields_missing, []);
  assert.deepEqual(fromDom.fields_present.length, ITEM_FIELDS.length);
});

test('item_view refuses a detail reply about a different listing, and reports a refusal as a refusal', async () => {
  // The page decides which listing to render. An answer about another id is not a partial success.
  use(makeSession({ item: [UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [ok({ itemDO: { itemId: '999', title: '别人的东西', soldPrice: '1' }, sellerDO: {} })] } }));
  await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => e instanceof DetailUnavailableError && /instead of 42/.test(e.message));
  // goofish's own code is quoted rather than summarised: RGV587 is an IP throttle and says nothing
  // about whether the listing exists, and a reader cannot tell those apart without it.
  use(makeSession({ item: [UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [refused('RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!')] } }));
  await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => e instanceof DetailUnavailableError && /RGV587/.test(e.message));
});

test('a browser close that hangs is bounded and escalated, and never orphans the process', async () => {
  // This runs on the way out of the server, and a `close()` that hangs -- an evaluate in flight
  // against a page that has stopped answering -- used to leave a windowed Chromium running after the
  // process had exited, invisible to the client that had already gone. Measured: one to two orphaned
  // browser processes per session.
  const s = new Session();
  const killed: string[] = [];
  const browser: any = {
    close: () => new Promise(() => {}),                    // never settles
    process: () => ({ exitCode: null, killed: false, kill: (sig: string) => killed.push(sig) }),
  };
  (s as any).browser = browser;
  (s as any).context = { close: async () => { throw new Error('target closed'); } };
  const began = Date.now();
  await s.close();
  const spent = Date.now() - began;
  assert.ok(spent < 8000, `close() took ${spent}ms: a hung close holds the process open`);
  assert.deepEqual(killed, ['SIGKILL'], 'a browser that would not close is killed, not left running');
  // and it is idempotent: the signal path and the exit path can both reach it
  await s.close();
  assert.equal(killed.length, 1, 'the second close did not kill an already-closed browser again');
  // `killBrowser` is the synchronous half, for the paths where there is no event loop left to await:
  // a `process.on('exit')` hook, and a teardown that was cut short. It must tolerate a browser that is
  // already gone rather than throwing on the way out of the process.
  const gone = new Session();
  (gone as any).browser = { process: () => { throw new Error('the connection is already closed'); } };
  assert.doesNotThrow(() => gone.killBrowser());
  assert.equal(gone.browserProcess(), null);
});

test('concurrent mtop calls launch and park the browser once, and never navigate it twice at once', async () => {
  // The mtop-only tools stopped queueing behind the DOM tools, so they now genuinely arrive together
  // -- and two `page.goto`s on one page abort each other, which is a `net::ERR_ABORTED` out of a
  // perfectly healthy browser. This drives the real `Session` against a fake page that throws if it
  // is navigated while a navigation is still in flight, which is exactly what two racing callers did.
  const s = new Session();
  const inFlight: string[] = [];
  const page: any = {
    url: () => (inFlight.length ? '' : 'https://www.goofish.com/x'),
    isClosed: () => false,
    reload: async () => {},
    waitForTimeout: async () => {},
    goto: async (u: string) => {
      if (inFlight.length) throw new Error(`ERR_ABORTED: navigated while ${inFlight[0]} was still loading`);
      inFlight.push(u);
      await new Promise((r) => setTimeout(r, 20));
      inFlight.pop();
    },
    evaluate: async (fn: any, arg: any) => {
      if (fn === MTOP_READY_JS) return 'ready';
      // answer whatever was asked for, so the tools under test see a working client
      if (Array.isArray(arg?.calls)) return Object.fromEntries(arg.calls.map(([label, api]: any) => [label, { ret: 'SUCCESS', ok: true, data: api.includes('hitnum') ? { hitnum: 28800 } : api.includes('suggest') ? { items: [], totalCount: 0 } : { cardList: [] } }]));
      return {};
    },
  };
  (s as any).apiPage = page; (s as any).domPage = page;
  use(s);
  const [a, b] = await Promise.all([
    run('search_count')({ query: 'x220' }),
    run('search_count')({ query: 'ipad' }),
  ]);
  // none of them raised, and none of them navigated while another was in flight
  assert.equal(a.match_count + b.match_count >= 0, true);
  assert.deepEqual(inFlight, []);
});

test('item_view reads the page for a listing a search already returned, and falls back to the card', async () => {
  // Searching and then opening a result is the ordinary sequence. The page is still read, because
  // the detail call is 4-10s and carries a dozen fields the card does not -- short-circuiting on the
  // cache would have bought nothing and thrown them away. The card is what is left when the page
  // will not answer, which is what a sold or removed listing looks like.
  const c = searchCase('x220', [['联想Thinkpad X220 笔记本电脑', '856961429564', '329', '北京', '5']]);
  use(makeSession({ cards: [c.rows], mtop: c.mtop }));
  // the search itself seeds the card cache, which is the state under test here
  const found = await run('search_items')({ query: 'x220', limit: 5 });
  assert.equal(found.source, 'search_api');
  assert.equal(found.items[0].item_id, '856961429564');
  assert.equal(found.items[0].want_count, '5', 'the search reply carries a want count the DOM card never showed');
  assert.equal(found.items[0].city, '北京', 'and the city, and the image');
  assert.ok(found.items[0].image_urls.length, 'and an image');

  // the page answers, and the answer is the detail block, not the card
  use(makeSession({ item: [UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [ok({ itemDO: { itemId: '856961429564', title: '联想Thinkpad X220 笔记本电脑', soldPrice: '329', wantCnt: 5, browseCnt: 900, desc: '成色好' }, sellerDO: { nick: '卖家', city: '北京', hasSoldNumInteger: 12, userRegDay: 730, newGoodRatioRate: '99%' } })] } }));
  const out = await run('item_view')({ item_id: '856961429564' });
  assert.equal(out.source, 'item_detail_api');
  assert.equal(out.seller, '卖家');
  assert.equal(out.browse_count, '900');

  // the page will not answer: then, and only then, the card this process already holds answers.
  // The TTL cache is cleared first, because a listing already read *in full* above is a better answer
  // than the card and is served without consulting the page at all -- so this half is about what a
  // process that has never read this listing in full does, which is what a cold one always does.
  resetCaches();
  use(makeSession({ item: [UNRENDERED, UNRENDERED, UNRENDERED] }));
  const fallback = await run('item_view')({ item_id: '856961429564' });
  assert.equal(fallback.source, 'search_card_cache');
  assert.equal(fallback.title, '联想Thinkpad X220 笔记本电脑');
  assert.ok(fallback.page_attempts > 0, 'the page really was tried first');
  // a card is not a detail block, and does not pretend to be one
  assert.ok(fallback.fields_missing.includes('description'));
  assert.ok(fallback.fields_missing.includes('browse_count'));
  assert.match(fallback.note, /earlier search in this session/);
  // the fourth route, and the one most likely to look like a detail block because it is a whole
  // listing object: the typed block is rebuilt from the card, so the fields the item page alone
  // carries are null here and named. `want_count` is in the list even though the card held one --
  // that route blanks the card fields it cannot vouch for, and `missing` is where that shows up
  // rather than being quietly indistinguishable from "the site sent none".
  assert.deepEqual(fallback.missing, ['want_count', 'view_count', 'collect_count', 'condition', 'published_at', 'updated_at', 'location.province', 'shipping', 'seller_stats']);
  assert.equal(fallback.typed.want_count, null, 'blanked on this route, and named as such');
  assert.equal(fallback.typed.price_amount, 329, 'but the price the card does carry is still typed');
  assert.equal(fallback.typed.location?.city, '北京', 'and the city the search reply gave it');
});

test('search_items answers from the page\'s own search reply, and holds it to the same relevance guard', async () => {
  // 30 results, 26 of which really contain the query.
  const cards = Array.from({ length: 30 }, (_, i) => [`联想Thinkpad X220 笔记本 ${i}`, String(856961429564 + i), String(100 + i), '北京', '3']);
  cards.push(['完全无关的自行车', '999', '1', '上海', '0']);
  const c = searchCase('thinkpad x220', cards);
  const s = use(makeSession({ cards: [c.rows], mtop: c.mtop }));
  const out = await run('search_items')({ query: 'thinkpad x220', limit: 10 });
  assert.equal(out.source, 'search_api');
  assert.equal(out.count, 10, 'limit still applies to a 30-result reply');
  assert.equal(out.scraped_cards, 31, 'the guard is over every result, not the ten kept');
  assert.equal(out.query_hits, 30);
  assert.equal(out.non_matching_count, 1);
  assert.ok(out.items.every((i: any) => /X220/.test(i.title)), 'only real matches came back');
  assert.ok(out.items.every((i: any) => i.want_count && i.city && i.image_urls.length), 'and each carries the card fields the DOM scrape lost');
  assert.equal(out.attempts, 1);
  assert.deepEqual(s.opened, ['https://www.goofish.com/'], 'one page load: the reply answers it');
});

test('search_items refuses a search reply that is really the recommendation rail', async () => {
  // A declined anonymous search answers SUCCESS with 30 recommendations and no matches. A `hits > 0`
  // test would pass that; a fraction over the whole reply does not, and the DOM fallback still runs.
  const cards = Array.from({ length: 30 }, (_, i) => [`推荐商品 ${i}`, String(1000 + i), '5', '北京', '0']);
  const c = searchCase('thinkpad x220', cards);
  use(makeSession({ cards: [c.rows], scrape: [{ items: [], cards_scanned: 0, rendered: false, rail: '猜你喜欢' }], mtop: c.mtop }));
  await assert.rejects(run('search_items')({ query: 'thinkpad x220', attempts: 1, limit: 5 }), (e: any) => e instanceof SearchUnavailableError);
});

test('the mtop-only tools do not queue behind a search on the shared page', async () => {
  // One page meant a 70s search held up a feed call that does 1.5s of work. The api page and the dom
  // page are separate, and only the dom tools take the exclusive lock.
  //
  // This used to call `run('search_items')` inside its own `exclusive()` and assert the lock, which
  // proved nothing about the shipped server: the entry point wrapped every tool in `exclusive()`, so
  // the four mtop tools queued behind a search anyway, and this test never saw it. The lock now lives
  // on the tools themselves, so the calls below go through `TOOLS[i].run` exactly as index.ts invokes
  // them -- no hand-wrapping -- and still do not queue.
  const c = searchCase('x220', [['联想 X220 笔记本电脑', '4242', '99', '北京', '1']]);
  const s = use(makeSession({ cards: [c.rows], mtop: c.mtop }, { hitnum: { ok: true, ret: 'SUCCESS', data: { hitnum: 28800 } } }));
  let searchDone = false;
  // `search_items` is registered locked, so this call takes the lock itself -- exactly as the entry
  // point now does, because index.ts no longer wraps anything.
  const searching = run('search_items')({ query: 'x220', limit: 1 }).then(() => { searchDone = true; });
  // not locked: this is the point -- an mtop-only call does not take the lock at all
  const counted = await run('search_count')({ query: 'x220' });
  assert.equal(counted.match_count, 28800);
  assert.equal(searchDone, false, 'the search is still running, and the count did not wait for it');
  await searching;
  assert.equal(searchDone, true);
  // and two DOM tools at once still serialise, because they share the one navigating page
  let order: string[] = [];
  const slow = exclusive(async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 30)); order.push('a-end'); });
  const fast = exclusive(async () => { order.push('b'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
  assert.equal(s.launches, 0);
});

test('the lock is on the three DOM tools and nowhere else, through the registered tool table', async () => {
  // The regression guard for the defect above, stated about the tool table itself rather than about
  // one hand-wrapped call. Which tools take the shared-page lock is a contract with index.ts -- it
  // must not wrap them again, or the fast tools queue behind every slow one -- so assert it here.
  const LOCKED = ['search_items', 'item_view'];
  const free = TOOLS.filter((t) => !LOCKED.includes(t.name)).map((t) => t.name);
  // The two seller tools are in the free set for a reason that is not "they never touch the dom page":
  // given a user_id they do not, and given an item_id they take the lock for exactly the hop that
  // resolves the seller and release it before their mtop calls. Wrapping them whole would be the
  // defect this test exists to catch; the scoped lock is pinned by its own invariant scan.
  assert.deepEqual(free.sort(), ['browse_feed', 'capabilities', 'related_items', 'search_count', 'seller_items', 'seller_profile']);
  // `capabilities` is deliberately free: it only reads, never navigates, and it is the tool an agent
  // calls when something else is stuck -- queueing it behind the stuck search would be perverse.
  // Proof by behaviour: an mtop call in flight while a DOM call holds the lock still answers.
  const c = searchCase('x220', [['联想 X220 笔记本电脑', '4242', '99', '北京', '1']]);
  const s = use(makeSession({ cards: [c.rows], mtop: c.mtop }, { hitnum: { ok: true, ret: 'SUCCESS', data: { hitnum: 28800 } } }));
  let released = false;
  const domHeld = exclusive(async () => { await new Promise((r) => setTimeout(r, 25)); released = true; });
  const count = await run('search_count')({ query: 'x220' });   // must not wait for the held lock
  assert.equal(released, false, 'the count answered while the lock was held -- it does not queue');
  assert.equal(count.match_count, 28800);
  await domHeld;
  assert.equal(released, true);
});

test('a seller lookup by user_id never waits for the lock, and one by item_id only waits for the hop', async () => {
  // The two halves of the scoped lock, by behaviour rather than by reading the source. A lookup by
  // seller id is one mtop call, so it must answer while a DOM call holds the shared page -- otherwise
  // a 70s search would delay a 1.5s seller lookup for no reason at all.
  const head = { ok: true, ret: 'SUCCESS::调用成功', data: HEAD };
  const s = use(makeSession({}, { head }));
  let released = false;
  const domHeld = exclusive(async () => { await new Promise((r) => setTimeout(r, 40)); released = true; });
  const byId = await run('seller_profile')({ user_id: '2214350705775' });
  assert.equal(released, false, 'the seller lookup waited for a held lock, and it had no page to read');
  assert.equal(byId.display_name, '汴梁资深化镁');
  assert.deepEqual(s.opened, []);
  await domHeld;
  assert.equal(released, true);
  // And the item_id route really does take the lock -- it navigates the dom page, which is exactly
  // what the lock exists to serialise. Queued behind a DOM call, it waits; then it answers.
  const s2 = use(makeSession({ item: [UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [ok({
    itemDO: { itemId: '42', title: '男士羊毛呢大衣' }, sellerDO: { sellerId: '2214350705775', city: '北京' },
  })] } }, { head }));
  let done = false;
  let releaseDom = () => {};
  const held = exclusive(() => new Promise<void>((r) => { releaseDom = r; }));
  const searching = run('seller_profile')({ item_id: '42' }).then((out: any) => { done = true; return out; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(done, false, 'the item_id hop must queue behind whatever holds the dom page');
  assert.deepEqual(s2.opened, [], 'and it must not have navigated while the lock is held');
  releaseDom();
  await held;
  const out: any = await searching;
  assert.equal(out.city, '北京');
  assert.deepEqual(s2.opened, ['https://www.goofish.com/item?id=42']);
});

test('search_items walks the pager for more pages, and the guard runs over the whole pooled set', async () => {
  // One reply is 30 listings and the search API cannot be re-issued, so the page's own pager is the
  // only way deeper. Three replies of 10, pooled, and the guard has to judge all thirty at once --
  // judging page 3 on its own could throw away two good pages.
  const page = (n: number, titles: string[]) => ok(searchReply('x220', titles.map((t, i) => [t, String(n * 100 + i), '50', '北京', '1'])));
  const t1 = Array.from({ length: 10 }, (_, i) => `联想 X220 键盘 ${i}`);
  const t2 = Array.from({ length: 10 }, (_, i) => `ThinkPad X220 笔记本 ${i}`);
  const t3 = Array.from({ length: 10 }, (_, i) => `X220 屏幕 ${i}`);
  const s = use(makeSession({ mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [page(1, t1), page(2, t2), page(3, t3)] } }));
  s.runRealNormalizer = true;
  // `limit` 100 against 30 available listings: the pool is short, so the walk tops up past the three
  // pages asked for, and stops when the pager runs out of replies. Measured live, this is what makes
  // `pages: 2` return 55 matches one run and 25 the next without either being a silent shortfall.
  const deep = await run('search_items')({ query: 'x220', pages: 3, limit: 100, attempts: 1 });
  assert.equal(deep.source, 'search_api');
  assert.equal(deep.pages_fetched, 3, 'three pages were pooled, not one');
  assert.equal(deep.scraped_cards, 30, 'and the guard saw all thirty');
  assert.deepEqual(s.pagers, ['2', '3', '4'], 'the third page left the pool short of limit, so it walked one more');
  assert.ok(deep.count > 0);

  // And the other half: a pool that already satisfies `limit` does not walk past what was asked for.
  // Cleared first, and that is the point: the walk above left pages 1-3 of this exact query in the
  // cache, so without a clear this second call would be answered from it -- correctly, and without
  // walking anything, which is the behaviour the previous line proves rather than this one.
  resetCaches();
  const s2 = use(makeSession({ mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [page(1, t1), page(2, t2), page(3, t3)] } }));
  s2.runRealNormalizer = true;
  const exact = await run('search_items')({ query: 'x220', pages: 2, limit: 10, attempts: 1 });
  assert.equal(exact.pages_fetched, 2);
  assert.deepEqual(s2.pagers, ['2'], 'ten of the first page\'s ten was enough, so no top-up');
});

test('search_items stops walking when the pager has no such page, and says why', async () => {
  // A real pager runs out at page 10 (`1..10 ... 50`) and a declined one may not be there at all.
  const s = use(makeSession({ mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [ok(searchReply('x220', Array.from({ length: 12 }, (_, i) => [`联想 X220 ${i}`, String(i), '50', '北京', '1'])))] } }));
  s.runRealNormalizer = true;
  s.max_page = 1;   // the page offers nothing beyond what we have
  const out = await run('search_items')({ query: 'x220', pages: 5, limit: 20, attempts: 1 });
  assert.equal(out.pages_fetched, 1, 'one page, and the walk did not invent the rest');
  assert.deepEqual(s.pagers, ['2']);
  const stopped = out.attempt_log.find((e: any) => e.pager && e.ok === false);
  assert.equal(stopped.pager, 2, 'and the refusal is in the log, with the page it stopped on');
});

test('the deeper walk stops at XIANYU_SEARCH_MAX_ITEMS, and the rail is still never returned as results', async () => {
  // Full-depth pages on offer (99), and a call that asks for everything: pages 10, limit 300.
  // With XIANYU_SEARCH_MAX_ITEMS=60 the walk must stop after two pages -- one page of 30 per 30 of
  // the cap -- rather than climbing to ten, and it must do so without another page load: one warm
  // search, then pager clicks only.
  const pgs = (n: number) => ok(searchReply('x220', Array.from({ length: 30 }, (_, i) => [`联想 X220 ${n}-${i}`, String(n * 100 + i), '50', '北京', '1'])));
  process.env.XIANYU_SEARCH_MAX_ITEMS = '60';
  const s = use(makeSession({ mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [pgs(1), pgs(2), pgs(3), pgs(4)] } }));
  s.runRealNormalizer = true;
  const capped = await run('search_items')({ query: 'x220', pages: 10, limit: 300, attempts: 1 });
  assert.deepEqual(s.pagers, ['2'], 'the walk stopped at the cap, not at the pager');
  assert.equal(capped.pages_fetched, 2);
  assert.equal(capped.scraped_cards, 60, 'the guard pooled exactly the two capped pages');
  assert.ok(capped.count <= 60, 'limit itself is clamped by the cap');
  assert.equal(s.opened.length, 1, 'one page load; the deeper walk rides the shared page, no extra launches');

  // The cap does not weaken the relevance guard: a search reply that is really the recommendation
  // rail is still refused as results, end to end, through the same walk.
  delete process.env.XIANYU_SEARCH_MAX_ITEMS;
  const railReply = ok(searchReply('x220', Array.from({ length: 30 }, (_, i) => [`推荐商品 ${i}`, String(2000 + i), '5', '北京', '0'])));
  const railDom = { rendered: true, query_hits: 0, cards_scanned: 40, rail: '猜你喜欢', says_no_results: true, text_preview: '猜你喜欢', items: [] };
  use(makeSession({ scrape: [railDom], mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [railReply, railReply] } }));
  await assert.rejects(run('search_items')({ query: 'x220', pages: 3, attempts: 1 }), (e: any) => e instanceof SearchUnavailableError && /"rail":"猜你喜欢"/.test(e.message));
});

test('the `detail` argument reads the top N in full, and reports which ones it could not', async () => {
  // Run serially: this is about the walk and the honesty of the report, and the fan-out drives its own
  // pages rather than this scripted tap -- which is exactly the route the fan-out's own guard falls
  // back to, so testing it here covers the fallback as much as the original behaviour.
  process.env.XIANYU_DETAIL_FANOUT = '0';
  const rows = Array.from({ length: 8 }, (_, i) => [`联想 X220 ${i}`, String(300 + i), String(100 + i * 10), '北京', '2']);
  const c = searchCase('x220', rows);
  // the detail reply comes back for three of the four requested, and the fourth is refused
  const detail = (id: string) => ok({ itemDO: { itemId: id, title: `详情 ${id}`, soldPrice: '123', wantCnt: 4, browseCnt: 900, desc: '成色好，功能正常' }, sellerDO: { nick: '卖家', city: '北京', hasSoldNumInteger: 12, userRegDay: 730, newGoodRatioRate: '99%' } });
  // one tap for both: the search reply that produces the cards, and the detail replies that deepen them
  use(makeSession({ cards: [c.rows], mtop: {
    'mtop.taobao.idlemtopsearch.pc.search': c.mtop['mtop.taobao.idlemtopsearch.pc.search'],
    'mtop.taobao.idle.pc.detail': [detail('300'), detail('301'), detail('302'), refused('RGV587_ERROR::SM::哎哟喂')],
  } }));
  const out = await run('search_items')({ query: 'x220', detail: 4, limit: 8, attempts: 1 });
  assert.equal(out.detail_requested, 4);
  assert.equal(out.detail_report.length, 4);
  // The fourth was refused by goofish, so it falls back to the search card this same call just
  // returned -- a real listing, but a card. It is reported as what it answered from rather than
  // dropped, which is the difference between a shorter list and a dishonest one.
  const fourthReport = out.detail_report.find((r: any) => r.item_id === '303');
  assert.equal(fourthReport.ok, true);
  assert.equal(fourthReport.source, 'search_card_cache');
  assert.equal(out.detail_report.filter((r: any) => r.source === 'item_detail_api').length, 3);
  // `detail_ms` is what the depth cost, so a caller can price the next call. Assert the field is
  // present and is the sum of the per-listing costs -- not that it is nonzero. The fake session
  // answers with no delay, so three reads can legitimately total 0ms; a wall-clock assertion here
  // passes on a fast machine and fails on a loaded one, which is how it reached CI green-then-red.
  assert.equal(typeof out.detail_ms, 'number');
  assert.equal(out.detail_ms, out.detail_report.reduce((a: number, r: any) => a + (r.ms ?? 0), 0));
  // the three that worked carry the detail fields; the fourth is still a card
  const first = out.items.find((i: any) => i.item_id === '300');
  assert.equal(first.description, '成色好，功能正常');
  assert.equal(first.seller, '卖家');
  assert.equal(first.seller_items_sold, '12');
  assert.equal(first.detailed, true);
  const fourth = out.items.find((i: any) => i.item_id === '303');
  assert.equal(fourth.detailed, true, 'it came back, from the search card rather than the page');
  assert.equal(fourth.detail_source, 'search_card_cache', 'and says so');
  assert.equal(fourth.description, '', 'so nothing pretends the description was read');
  assert.equal(out.items.length, 8, 'and the other four are untouched');
});

/** A search that answers, plus a `detail` that deepens it -- the fixture every fan-out test below is
 *  built on, because the fan-out only ever runs against a real ranked result set. */
const deepenable = (rows: string[][], mtop: Record<string, any[]>, poolMs?: number, poolSilent?: boolean) => {
  const c = searchCase('x220', rows);
  return use(makeSession({ cards: [c.rows], poolMs, poolSilent, mtop: { 'mtop.taobao.idlemtopsearch.pc.search': c.mtop['mtop.taobao.idlemtopsearch.pc.search'], ...mtop } }));
};

test('`detail` reads two listings at a time on pages of its own, and never touches the shared page', async () => {
  // Measured on this server: four pages loading four listings at once took the batch's wall clock from
  // 66.3s to 27.1s, at the price of each listing's own latency going 11.4s -> 20.5s. So the fan-out is
  // built rather than merely described, at two, and everything it does is published.
  const rows = Array.from({ length: 8 }, (_, i) => [`联想 X220 ${i}`, String(300 + i), '199', '北京', '2']);
  const s = deepenable(rows, {}, 25);
  const out = await run('search_items')({ query: 'x220', detail: 4, limit: 8, attempts: 1 });
  assert.equal(out.detail_requested, 4);
  // Two slots, two batches, every listing read from goofish on a pool page of its own.
  assert.equal(out.detail_fanout.width, 2);
  assert.equal(out.detail_fanout.batches, 2);
  assert.equal(out.detail_fanout.listings_fanned, 4);
  assert.equal(out.detail_fanout.fell_back, null, 'a healthy site never trips the guard');
  assert.equal(out.detail_report.length, 4);
  for (const r of out.detail_report) {
    assert.equal(r.via, 'fanout', `${r.item_id} must say where it ran`);
    assert.equal(r.source, 'item_detail_api', `${r.item_id} came off the page's own detail reply`);
    assert.equal(typeof r.ms, 'number');
    assert.ok(r.slot === 0 || r.slot === 1, `${r.item_id} names its pool slot`);
  }
  // The two loads in each batch overlap. That is the claim being tested -- a serial walk would leave
  // `from` of the second load at or after the `to` of the first -- and it is why the fake's load costs
  // real time rather than resolving instantly.
  assert.equal(s.poolLoads.length, 4);
  for (let batch = 0; batch < 2; batch++) {
    const [a, b] = s.poolLoads.slice(batch * 2, batch * 2 + 2);
    assert.equal(a.slot, 0); assert.equal(b.slot, 1);
    assert.ok(a.to > b.from, `batch ${batch + 1} ran its two loads one after the other, which is a serial walk`);
  }
  // ...and the shared dom page never navigated for a detail read. It is holding the search results this
  // call is deepening, which is the reason the pool exists at all.
  assert.deepEqual(s.opened, [HOME], 'the shared page must be used for the search and nothing else');
  // each listing still carries the fields only a detail read has, on its own card
  const first = out.items.find((i: any) => i.item_id === '300');
  assert.equal(first.description, '成色好，功能正常');
  assert.equal(first.seller, '卖家');
  assert.equal(first.detailed, true);
  assert.equal(first.detail_source, 'item_detail_api');
});

test('a fan-out batch that goofish answers nothing for falls back to serial, and says so', async () => {
  // The half of the measurement that decided the shape: on a throttled site four-at-once answered 0/4
  // where the serial walk still answered 2/4. Batching must never be the reason a listing is missed, so
  // the first batch with no answer at all turns the fan-out off for the rest of the call -- and says
  // that it did, in the envelope, rather than quietly costing the caller a slower detail.
  const rows = Array.from({ length: 8 }, (_, i) => [`联想 X220 ${i}`, String(300 + i), '199', '北京', '2']);
  // The pool pages refuse everything. The shared page's tap answers for the two listings the serial
  // route goes on to read, which is the serial route still working -- exactly run 2 of the measurement.
  const live = (id: string) => ok({ itemDO: { itemId: id, title: `详情 ${id}`, soldPrice: '123', desc: '成色好，功能正常' }, sellerDO: { nick: '卖家', city: '北京' } });
  const s = deepenable(rows, { 'mtop.taobao.idle.pc.detail': [live('302'), live('303')] }, 0, true);
  const out = await run('search_items')({ query: 'x220', detail: 4, limit: 8, attempts: 1 });
  assert.equal(out.detail_fanout.batches, 1, 'only the first batch ran: the guard stopped the rest');
  assert.equal(out.detail_fanout.listings_fanned, 2);
  assert.match(out.detail_fanout.fell_back, /answered none of the 2 listing\(s\) in fan-out batch 1/);
  assert.match(out.detail_fanout.fell_back, /read serially/, 'and it names the route it fell back to');
  // the pool did not load the second batch, and the shared page read the rest itself
  assert.equal(s.poolLoads.length, 2);
  assert.deepEqual(s.opened, [HOME, `${HOME}item?id=302`, `${HOME}item?id=303`]);
  // A listing that was not read is reported as such and left as a card -- the fan-out did not drop it,
  // and it did not pretend the card was a detail block.
  for (const card of out.items.filter((i: any) => ['300', '301'].includes(i.item_id))) {
    assert.equal(card.detailed, true, 'it came back, from the search card');
    assert.equal(card.detail_source, 'search_card_cache');
    assert.equal(card.description, '');
  }
  for (const card of out.items.filter((i: any) => ['302', '303'].includes(i.item_id))) assert.equal(card.detail_source, 'item_detail_api', 'the serial route still answered');
  // every listing is still accounted for, in request order, whichever route answered it
  assert.deepEqual(out.detail_report.map((r: any) => r.item_id), ['300', '301', '302', '303']);
  assert.deepEqual(out.detail_report.map((r: any) => r.via), ['fanout', 'fanout', 'serial', 'serial']);
});

test('XIANYU_DETAIL_FANOUT turns the fan-out off, and is clamped to what was measured', async () => {
  // Two is the default, and the operator's off-switch is 0 -- which must be the same serial walk that
  // shipped before the fan-out existed, not a fan-out of width one dressed up as one.
  assert.equal(fanoutSize(), 2);
  for (const [raw, want] of [['0', 0], ['1', 1], ['4', 4], ['9', DETAIL_POOL_MAX], ['-3', 0], ['', 2], ['wide', 2], ['2.5', 2]] as const) {
    process.env.XIANYU_DETAIL_FANOUT = raw;
    assert.equal(fanoutSize(), want, `XIANYU_DETAIL_FANOUT=${JSON.stringify(raw)}`);
  }
  delete process.env.XIANYU_DETAIL_FANOUT;

  process.env.XIANYU_DETAIL_FANOUT = '0';
  const rows = Array.from({ length: 8 }, (_, i) => [`联想 X220 ${i}`, String(300 + i), '199', '北京', '2']);
  const s = deepenable(rows, {});
  const out = await run('search_items')({ query: 'x220', detail: 4, limit: 8, attempts: 1 });
  assert.equal(out.detail_fanout.width, 0);
  assert.equal(out.detail_fanout.batches, 0);
  assert.equal(out.detail_fanout.fell_back, null, 'it never ran, so it has nothing to report falling back from');
  assert.match(out.detail_fanout.note, /one at a time/);
  assert.deepEqual(s.poolLoads, [], 'and no page was leased');
  assert.deepEqual(s.opened, [HOME, `${HOME}item?id=300`, `${HOME}item?id=301`, `${HOME}item?id=302`, `${HOME}item?id=303`]);
  for (const r of out.detail_report) assert.equal(r.via, 'serial');
});

test('a fan-out slot past the measured width is refused, and its page is navigated like any other', async () => {
  // The real Session, with a fake page: the bound is a refusal rather than a silent clamp, and a
  // fan-out page goes through the same checked navigation site every other load goes through --
  // including the check that goofish did not redirect us somewhere else.
  const { s, page } = realSession();
  (s as any).context = { newPage: async () => page };
  const item = `${HOME}item?id=42`;
  const surface = await s.fanoutSurface(0, item);
  assert.equal(surface.page, page);
  assert.equal(surface.load.declined, '');
  assert.ok(surface.tap, 'each slot carries its own tap, so a reply cannot cross to the page that did not make the call');
  assert.equal(page.calls[page.calls.length - 1], item, 'and it loaded the listing it was leased for');
  for (const slot of [DETAIL_POOL_MAX, DETAIL_POOL_MAX + 1, -1, 1.5]) {
    await assert.rejects(() => s.fanoutSurface(slot, item), (e: any) => e instanceof BrowserError, `slot ${slot} must not open a page`);
  }
  const off = realSession({ land: () => 'https://evil.com/item?id=42' });
  (off.s as any).context = { newPage: async () => off.page };
  await assert.rejects(() => off.s.fanoutSurface(0, item), (e: any) => e instanceof NavigationError);
  const wrong = realSession({ land: () => 'http://www.goofish.com/item?id=42' });
  (wrong.s as any).context = { newPage: async () => wrong.page };
  await assert.rejects(() => wrong.s.fanoutSurface(0, item), (e: any) => e instanceof NavigationError);
});

test('a search card carries the seller, tags, avatar and publish time, not just a title and a price', async () => {
  // All of it is in the reply we already had. The seller was the visible gap: a search card's name is
  // All of it is in the reply we already had. The seller was the visible gap: a search card's name is
  // `exContent.userNickName`, and reading `userNick` -- which does not exist on a search card -- left
  // every search result with an empty seller while the feed cards had one.
  const reply = searchReply('thinkpad x220', [['联想Thinkpad X220 笔记本', '1', '329', '北京', '5']]);
  const main = reply.resultList[0].data.item.main;
  main.exContent.detailParams = { ...main.exContent.detailParams, itemId: '1', title: '联想Thinkpad X220 笔记本', soldPrice: '329', picUrl: 'https://img.alicdn.com/bao/uploaded/i1/1.jpg' };
  Object.assign(main.exContent, { userNickName: '松花江逃跑的香蕉', userAvatarUrl: 'http://img.alicdn.com/bao/uploaded/i1/avatar.jpg', userFishShopLabel: { config: { x: 1 } }, showVideoIcon: true, want: '5',
    fishTags: { r2: { tagList: [{ data: { content: '18天内降价' } }] }, r4: { tagList: [{ data: { content: '卖家信用极好' } }] }, r1: { tagList: [{ data: { content: 'freeShippingIcon' } }] } } });
  main.clickParam.args.publishTime = '1784640276000';
  const { FEED_NORMALIZE_JS, searchListings } = await import('../src/extract.ts');
  const row = FEED_NORMALIZE_JS({ rows: searchListings(reply) })[0];
  assert.equal(row.seller, '松花江逃跑的香蕉', 'the seller name lives in userNickName');
  assert.equal(row.seller_avatar, 'https://img.alicdn.com/bao/uploaded/i1/avatar.jpg');
  assert.equal(row.seller_shop, true);
  assert.equal(row.is_video, true);
  assert.equal(row.want_count, '5');
  assert.equal(row.publish_time, '1784640276000');
  assert.deepEqual(row.tags, ['18天内降价', '卖家信用极好'], 'the tag strip, minus the icon placeholder');
  assert.equal(row.price, '329');
});

test('item_view reports every promised field, and missing ones as missing rather than filled in', async () => {
  use(makeSession({ item: [{ ...RENDERED, description: '', image_urls: [] }] }));
  const out = await run('item_view')({ item_id: '42' });
  assert.equal(out.price, '1999');
  assert.equal(out.page_item_id, '42', 'the id the page actually served is the evidence for that');
  assert.equal(out.seller, '汴梁');
  assert.deepEqual(out.image_urls, []);
  // an empty gallery is *not* a present field, and nothing is invented to fill the gap
  assert.deepEqual(out.fields_missing, ['description', 'image_urls']);
  assert.deepEqual([...out.fields_present, ...out.fields_missing].sort(), ['browse_count', 'description', 'image_urls', 'price', 'seller', 'seller_items_sold', 'seller_positive_rate', 'seller_tenure_years', 'title', 'want_count']);
  assert.equal(out.account_required, false);
  // a gallery that is absent entirely is an empty list, not a string: the field is promised as a list
  use(makeSession({ item: [{ ...RENDERED, image_urls: undefined }] }));
  const gone = await run('item_view')({ item_id: '42' });
  assert.deepEqual(gone.image_urls, []);
  assert.ok(gone.fields_missing.includes('image_urls'));
});

test('item_view accepts a pasted item URL, and refuses garbage before touching the browser', async () => {
  const s = use(makeSession({ item: [{ ...RENDERED, requested_item_id: '777', page_item_id: '777' }] }));
  assert.equal((await run('item_view')({ item_id: 'https://www.goofish.com/item?id=777#detail&spm=a1z10.3' })).item_id, '777');
  assert.deepEqual(s.opened, ['https://www.goofish.com/item?id=777']);
  // a pasted URL contributes its id and nothing else, even from another host
  use(makeSession({ item: [RENDERED] }));
  assert.equal((await run('item_view')({ item_id: 'https://evil.com/steal?id=42' })).url, 'https://www.goofish.com/item?id=42');
  for (const bad of ['not-an-id', '42; DROP TABLE', '0x2a', '']) {
    const s3 = use(makeSession({ item: [RENDERED] }));
    await assert.rejects(run('item_view')({ item_id: bad }), XianyuError);
    assert.deepEqual(s3.opened, [], `the browser was touched for ${JSON.stringify(bad)}`);
  }
});

test('item_view refuses to report a different listing\'s fields -- or no listing at all -- and quotes the page text when it will not render', async () => {
  use(makeSession({ item: [{ ...RENDERED, page_item_id: '999' }] }));
  await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => e instanceof ParseError && /999/.test(e.message));
  // A page that renders the detail block but has no `?id=` anywhere is a redirect or a challenge
  // page, not this listing. The check used to be skipped whenever the served id was empty, which is
  // exactly what an off-site page looks like.
  use(makeSession({ item: [{ ...RENDERED, page_item_id: '' }] }));
  await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => e instanceof ParseError && /no \?id=/.test(e.message));
  use(makeSession({ item: [UNRENDERED, UNRENDERED, UNRENDERED] }));
  await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => {
    assert.ok(e instanceof DetailUnavailableError);
    // The wording changed when the cause was pinned down -- the page is login-gated, not slow -- so
    // the count and the clock are asserted separately rather than as one interpolated phrase.
    assert.match(e.message, /\b\d+ page load\(s\) in \d+s/);
    assert.match(e.message, /阿里巴巴/, 'the page text it actually saw must be quoted');
    return true;
  });
});

test('navigation is confined to goofish by the real Session, at both sites and after the redirect', async () => {
  // The fake session's `open` is a stand-in; this drives `Session.open` itself, so the check that
  // matters is the real `ensureGoofishUrl` rather than a copy of it sitting in the test double.
  // and a navigation that lands off-site -- goofish bouncing us, or anything in the page -- is caught
  // on the way back, before the DOM is read
  const bounced = realSession({ land: () => 'https://www.goofish.com.evil.com/', queues: { [SCRAPE_CARDS_JS as any]: [{ items: [{ item_id: '1', title: 'x', url: 'u' }] }] } });
  await assert.rejects(run('search_items')({ query: 'x220', attempts: 1 }), (e: any) => e instanceof SearchUnavailableError && /NavigationError/.test(e.message));
  assert.equal(bounced.page.calls.length, 1, 'it tried the target, and stopped there');
});

test('a page parked on a lookalike host is re-parked, and reloadFresh refuses to leave goofish', async () => {
  // currentPage() used to gate on `url().startsWith('https://www.goofish.com')`, which every one of
  // these passes and none of them is: the allowlist check everything else runs was simply missing
  // here, so ensureReady and call ran our JS on whatever the page was.
  for (const lookalike of ['https://www.goofish.com.evil.com/', 'https://www.goofish.com@evil.com/', 'https://www.goofish.computer/', 'https://www.goofish.com.attacker.tld/', 'https://sub.www.goofish.com/']) {
    const { s, page } = realSession({ start: lookalike });
    await s.ensureReady();
    // one assertion, because the recorded goto already implies the URL: it re-navigated to the boot
    // page, and that was the only navigation
    assert.deepEqual(page.calls, [BOOT_URL], `${lookalike} was treated as goofish, or was not re-parked`);
  }
  // if it will not settle on goofish, that is a refusal rather than a page to scrape
  const stuck = realSession({ start: 'https://www.goofish.computer/', land: () => 'https://www.goofish.computer/' });
  await assert.rejects(stuck.s.ensureReady(), (e: any) => e.constructor.name === 'NavigationError');
  // reloadFresh is the second goto site and re-checks where the redirect landed: it is called from
  // search_items, item_view and recommendations, which scrape whatever is here next.
  await assert.rejects(reloadFresh(drivenPage({ land: () => 'https://evil.com/steal' })), (e: any) => e.constructor.name === 'NavigationError');
  const onSite = drivenPage();
  await reloadFresh(onSite);
  assert.match(onSite.url(), /^https:\/\/www\.goofish\.com\/.+_r\d+$/);
  // reloading a page that already carries a nonce must replace it, not stack another one on: `base`
  // used to be read from the already-busted url(), so the query grew `&_r=1&_r=2&_r=3`
  await reloadFresh(onSite);
  await reloadFresh(onSite);
  assert.equal((onSite.url().match(/_r/g) ?? []).length, 1, `the cache-buster accumulated: ${onSite.url()}`);
});

test('related_items sends goofish\'s own seed id and pageSize, and applies limit client-side', async () => {
  const s = use(makeSession({ cards: [listed(['111', '222', '333'])] }, { rec: { ok: true, ret: 'SUCCESS', data: { hasMore: true, cardList: ['111', '222', '333'].map((id) => ({ cardData: { itemId: id } })) } } }));
  const out = await run('related_items')({ limit: 2 });
  assert.deepEqual(s.specs[0][0][2], { itemId: '809806779491', categoryId: '', pageNum: 1, pageSize: 30, reqFrom: 'xianyuweb' });
  assert.equal(out.item_id, null);
  assert.equal(out.unique_items, 3);
  assert.equal(out.count, 2);
  assert.equal(out.has_more, true);
  assert.deepEqual(s.opened, [], 'the mtop-only path must not navigate');
  const s2 = use(makeSession({ cards: [listed(['9'])] }, { rec: { ok: true, ret: 'SUCCESS', data: { cardList: [{ cardData: { itemId: '9' } }] } } }));
  await run('related_items')({ item_id: 'https://www.goofish.com/item?id=777&x=1' });
  assert.equal(s2.specs[0][0][2].itemId, '777');
  use(makeSession({ cards: [[]] }, { rec: { ok: true, ret: 'SUCCESS', data: { cardList: [] } } }));
  await assert.rejects(run('related_items')({}), ParseError);
  // a non-list cardList, the shape browse_feed used to spread into a raw TypeError
  use(makeSession({ cards: [[]] }, { rec: { ok: true, ret: 'SUCCESS', data: { cardList: 'nope' } } }));
  await assert.rejects(run('related_items')({}), (e: any) => e.constructor.name === 'ParseError');
  // `page` is bounded like every other number in the contract, and the bound is what gets sent
  const s3 = use(makeSession({ cards: [listed(['9'])] }, { rec: { ok: true, ret: 'SUCCESS', data: { cardList: [{ cardData: { itemId: '9' } }] } } }));
  assert.equal((await run('related_items')({ page: 9e9 as any })).page, 10_000);
  assert.equal(s3.specs[0][0][2].pageNum, 10_000);
});

test('search_count reads the match counter, and zero matches is an answer, not an error', async () => {
  const s = use(makeSession({}, { hitnum: { ok: true, ret: 'SUCCESS', data: { hitnum: 28791 } } }));
  const out = await run('search_count')({ query: 'x220' });
  assert.deepEqual([out.match_count, out.has_matches], [28791, true]);
  assert.equal(s.specs[0][0][2].searchReqFromPage, 'pcSearch');
  assert.equal(s.specs[0][0][2].keyword, 'x220');
  assert.deepEqual(s.opened, []);
  use(makeSession({}, { hitnum: { ok: true, ret: 'SUCCESS', data: { hitnum: 0 } } }));
  assert.deepEqual([(await run('search_count')({ query: 'asdkjhqwezzz' })).match_count, (await run('search_count')({ query: 'z' })).has_matches], [0, false]);
  use(makeSession({}, { hitnum: { ok: false, ret: 'RGV587_ERROR::x', data: null } }));
  await assert.rejects(run('search_count')({ query: 'x220' }), GatedError);
  await assert.rejects(run('search_count')({ query: ' ' }), XianyuError);
  // "zero is an answer" is only true when the site said zero. A count that cannot be read -- moved,
  // null, a string, a thousands separator -- is a shape change, and answering "no matches" to "I
  // don't know" is the one reply this tool must never make.
  for (const hitnum of [{ total: 5 }, null, 'oops', '1,234', undefined, ''] as any[]) {
    use(makeSession({}, { hitnum: { ok: true, ret: 'SUCCESS', data: { hitnum } } }));
    await assert.rejects(run('search_count')({ query: 'x220' }), (e: any) => e instanceof ParseError && /unreadable hitnum/.test(e.message), JSON.stringify(hitnum));
  }
});

// ---- the two seller tools. Both fixtures below are the payloads read off the wire, not invented:
// `mtop.idle.web.user.page.head` captured from a /personal?userId= page, and `mtop.idle.web.xyh.item.list`
// captured from the same page's 宝贝 tab. What is NOT in them is the point of half the tests below.

/** A real `mtop.idle.web.user.page.head` reply. `module.base.ipLocation` is 上海市 while the seller is
 *  in 北京, which is the live measurement behind never publishing it as a city: it is where goofish
 *  thinks the request came from. */
const HEAD = {
  baseInfo: { encryptedUserId: 'strZSeNsALQaHGp6qPRb3g==', kcUserId: '2214350705775', self: false, userType: 1,
    tags: { real_name_certification_77: true, real_person_certification_77: true, idle_zhima_zheng: true, xianyu_user_upgrade: true, tb_xianyu_user: false } },
  module: {
    base: { ipLocation: '上海市', displayName: '汴梁资深化镁', introduction: '发现自己一个很不好的现象', avatar: { avatar: 'http://img.alicdn.com/bao/uploaded/i2/o.jpg' },
      ylzTags: [{ code: 'cs_seller_level', attributes: { role: 'seller', level: 5 }, text: '卖家信用极好' }, { code: 'cs_buyer_level', attributes: { role: 'buyer', level: 5 }, text: '买家信用极好' }] },
    shop: { level: 'L2', score: 42, praiseRatio: 100, reviewNum: 5, nextLevelNeedScore: 8, superShow: true },
    social: { followStatus: 1, followers: '11', following: '3' },
    tabs: { item: { number: 6, name: '宝贝' }, rate: { number: '19', name: '信用及评价' } },
  },
  needDecryptKeys: ['baseInfo.encryptedUserId'],
};
const headSession = (data: any = HEAD, extra: any = {}) => use(makeSession({}, { head: { ok: true, ret: 'SUCCESS::调用成功', data }, ...extra }));

/** A real `mtop.idle.web.xyh.item.list` reply, one card. `detailParams.title` is the listing title (and
 *  on this seller, a prose one, because that is what they typed); `detailUrl` is a `fleamarket://`
 *  deep link no browser can open, and `totalCount` is 0 on a seller with six live listings. */
const sellerCard = (itemId: string, title: string, price: string, extra: any = {}) => ({ cardType: 1003, cardData: {
  id: itemId, title, detailUrl: `fleamarket://awesome_detail?itemId=${itemId}`, categoryId: '50106003',
  detailParams: { itemId, title, soldPrice: price, picUrl: `http://img.alicdn.com/bao/uploaded/i4/${itemId}.jpg`, postInfo: '包邮' },
  priceInfo: { preText: '¥', price }, picInfo: { hasVideo: false, picUrl: `http://img.alicdn.com/bao/uploaded/i4/${itemId}.jpg`, width: 1024 },
  itemLabelDataVO: { labelBucketId: '5', labelData: { r3: { tagList: [{ data: { content: '2人想要' } }] } } },
  ...extra,
} });

test('seller_profile reads a seller by id with one mtop call, and never navigates', async () => {
  const s = headSession();
  const out = await run('seller_profile')({ user_id: '2214350705775' });
  // the payload is the whole parameter: no encrypted id, no cookie, nothing the profile page needed
  assert.deepEqual(s.specs[0][0][2], { userId: '2214350705775' });
  assert.deepEqual(s.opened, [], 'given a user_id this must not load a page -- that is the whole cost difference');
  assert.equal(out.source, 'idle_user_page_head');
  assert.equal(out.user_id, '2214350705775');
  assert.equal(out.display_name, '汴梁资深化镁');
  assert.equal(out.avatar_url, 'https://img.alicdn.com/bao/uploaded/i2/o.jpg', 'http is upgraded like every other image here');
  assert.equal(out.signature, '发现自己一个很不好的现象');
  assert.equal(out.seller_credit, '卖家信用极好');
  assert.equal(out.buyer_credit, '买家信用极好');
  assert.equal(out.level, 'L2');
  assert.equal(out.level_score, '42');
  assert.equal(out.praise_ratio, '100', 'a bare number here, where the detail payload carries "100%"');
  assert.equal(out.review_count, '5');
  assert.equal(out.listings_count, '6');
  assert.equal(out.ratings_count, '19');
  assert.deepEqual([out.followers, out.following], ['11', '3']);
  assert.deepEqual([out.verified_real_name, out.verified_real_person, out.verified_zhima], [true, true, true]);
  assert.equal(out.profile_url, 'https://www.goofish.com/personal?userId=2214350705775');
  assert.equal(out.item_id, null);
  assert.equal(out.account_required, false);
  // and the one field this payload does carry, which must not be published as the seller's city
  assert.equal(out.ip_location, undefined);
  assert.equal(out.city, '');
  assert.deepEqual(out.fields_missing, ['city', 'tenure_years', 'items_sold', 'items_listed', 'positive_rate', 'reply_rate_24h', 'last_active']);
  assert.match(out.note, /pass item_id/);
});

test('seller_profile given an item_id reads the listing\'s own detail reply, and takes the lock for it', async () => {
  // The seller of a listing is not reachable by mtop: re-issuing `mtop.taobao.idle.pc.detail` through
  // the page's own client answers TIMEOUT, so the hop is the item page's own call read off the wire.
  const s = use(makeSession({ item: [UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [ok({
    itemDO: { itemId: '42', title: '男士羊毛呢大衣', soldPrice: '1999' },
    sellerDO: { sellerId: '2214350705775', nick: '汴梁资深化镁', city: '北京', userRegDay: 1538, hasSoldNumInteger: 27, itemCount: 101, newGoodRatioRate: '100%', replyRatio24h: '50%', lastVisitTime: '3小时前来过' },
  })] } }, { head: { ok: true, ret: 'SUCCESS::调用成功', data: HEAD } }));
  const out = await run('seller_profile')({ item_id: 'https://www.goofish.com/item?id=42' });
  assert.deepEqual(s.opened, ['https://www.goofish.com/item?id=42'], 'the hop loads the listing page, under the shared lock');
  assert.equal(out.item_id, '42');
  assert.equal(out.source, 'item_detail+idle_user_page_head');
  assert.equal(out.city, '北京', 'the seller own record, not the profile payload ipLocation of 上海市');
  assert.equal(out.tenure_years, '4', 'userRegDay is in days: 1538 days is 4 years');
  assert.equal(out.items_sold, '27');
  assert.equal(out.items_listed, '101');
  assert.equal(out.positive_rate, '100');
  assert.equal(out.reply_rate_24h, '50');
  assert.equal(out.last_active, '3小时前来过');
  assert.deepEqual(out.fields_missing, [], 'every promised field is filled on this payload');
  assert.match(out.note, /detail record/);
});

test('seller_profile refuses the two ways it cannot answer, and never one seller\'s standing as another\'s', async () => {
  use(makeSession({}, { head: { ok: false, ret: 'FAIL_BIZ_USER_NOT_FOUND::没有这个用户', data: null } }));
  await assert.rejects(run('seller_profile')({ user_id: '1' }), (e: any) => e instanceof DetailUnavailableError && /FAIL_BIZ_USER_NOT_FOUND/.test(e.message));
  // A throttle is not "no such seller": reporting one as the other tells a caller their seller is gone
  // when the truth is that the IP was rate limited for a moment.
  use(makeSession({}, { head: { ok: false, ret: 'RGV587_ERROR::SM::哎哟喂,被挤爆啦', data: null } }));
  await assert.rejects(run('seller_profile')({ user_id: '2214350705775' }), (e: any) => e instanceof GatedError && e.constructor.name === 'GatedError' && /RGV587/.test(e.message));
  // A payload about a different seller than the one asked for is refused, on the same grounds as a
  // detail reply about a different listing: the page decides which seller to answer about.
  headSession({ ...HEAD, baseInfo: { ...HEAD.baseInfo, kcUserId: '999' } });
  await assert.rejects(run('seller_profile')({ user_id: '2214350705775' }), (e: any) => e instanceof ParseError && /999/.test(e.message));
  // ...and a profile with no id at all is a shape change, not an empty seller.
  headSession({ ...HEAD, baseInfo: { ...HEAD.baseInfo, kcUserId: '' } });
  await assert.rejects(run('seller_profile')({ user_id: '2214350705775' }), ParseError);
});

test('the seller tools ask for exactly one of user_id and item_id, and refuse garbage before the browser', async () => {
  for (const bad of [{ user_id: 'jRM3w0UnqSvHrFFMpqPdsQ==' }, { user_id: '2214350705775/../1' }, { item_id: 'not-an-id' }, { item_id: '42; DROP TABLE' }]) {
    const s = headSession();
    await assert.rejects(run('seller_profile')(bad), XianyuError);
    assert.deepEqual(s.opened, [], `${JSON.stringify(bad)} touched the browser`);
    assert.deepEqual(s.specs, [], `${JSON.stringify(bad)} reached the wire`);
  }
  // The encrypted id a search card carries is a different value, and page.head refuses it. Refusing it
  // here means the message names that rather than passing it on for goofish to reject.
  const s2 = headSession();
  await assert.rejects(run('seller_profile')({ user_id: 'jRM3w0UnqSvHrFFMpqPdsQ==' }), (e: any) => e instanceof XianyuError && /user_id must be digits/.test(e.message));
  assert.deepEqual(s2.specs, []);
  // Both is refused rather than one quietly winning: a caller who passes both has no way to see from
  // the envelope that their item_id was ignored.
  headSession();
  await assert.rejects(run('seller_profile')({ user_id: '2214350705775', item_id: '42' }), (e: any) => e instanceof XianyuError && /not both/.test(e.message));
  // Neither is a question with no subject, and the message says which two answers there are.
  headSession();
  await assert.rejects(run('seller_profile')({}), (e: any) => e instanceof XianyuError && /user_id .* or item_id/.test(e.message));
  await assert.rejects(run('seller_items')({}), XianyuError);
  // A pasted /personal URL is the other spelling of a user_id.
  const s3 = headSession();
  assert.equal((await run('seller_profile')({ user_id: 'https://www.goofish.com/personal?userId=2214350705775' })).user_id, '2214350705775');
  assert.deepEqual(s3.specs[0][0][2], { userId: '2214350705775' });
});

test('seller_items reads a seller\'s own listings, with nextPage as the only honest has_more', async () => {
  const cards = [sellerCard('1045171414271', '专柜入手，穿过几次', '1999'), sellerCard('990124788759', '【牛津衬衫】AF经典小麋鹿', '161'), sellerCard('765529563758', '【现货秒发】安苏衬', '2550')];
  const s = use(makeSession({}, { items: { ok: true, ret: 'SUCCESS::调用成功', data: { cardList: cards, nextPage: true, totalCount: 0 } } }));
  const out = await run('seller_items')({ user_id: '2214350705775' });
  assert.deepEqual(s.specs[0][0][2], { needGroupInfo: true, pageNumber: 1, userId: '2214350705775', pageSize: 20 });
  assert.deepEqual(s.opened, [], 'given a user_id this must not load a page');
  assert.equal(out.count, 3);
  assert.equal(out.has_more, true);
  assert.equal(out.raw_cards, 3);
  assert.equal(out.source, 'idle_xyh_item_list');
  assert.deepEqual(out.items[0], { item_id: '1045171414271', title: '专柜入手，穿过几次', price: '1999', category_id: '50106003', want_count: '2', tags: ['2人想要'], image_urls: ['https://img.alicdn.com/bao/uploaded/i4/1045171414271.jpg'], url: 'https://www.goofish.com/item?id=1045171414271', rank: 1 });
  assert.deepEqual(out.items.map((i: any) => i.rank), [1, 2, 3]);
  // `totalCount` is in the payload and is always 0 -- measured at two page sizes against a seller with
  // six live listings -- so it is never published as if it meant anything.
  assert.equal(out.total_count, undefined);
  // the web url is rebuilt from the id: this endpoint's own detailUrl is a fleamarket:// deep link
  assert.ok(out.items.every((i: any) => i.url.startsWith('https://www.goofish.com/item?id=')));
  // limit is applied after the call, page goes out in the payload, and a nonsense page is clamped
  assert.equal((await run('seller_items')({ user_id: '2214350705775', limit: 2 })).count, 2);
  const s2 = use(makeSession({}, { items: { ok: true, ret: 'SUCCESS::调用成功', data: { cardList: cards, nextPage: false } } }));
  const p3 = await run('seller_items')({ user_id: '2214350705775', page: 3 });
  assert.equal(p3.page, 3);
  assert.equal(s2.specs[0][0][2].pageNumber, 3);
  assert.equal(p3.has_more, false);
});

test('seller_items: an empty shop and a page past the end are answers, and a shape change is not', async () => {
  use(makeSession({}, { items: { ok: true, ret: 'SUCCESS::调用成功', data: { cardList: [], nextPage: false, totalCount: 0 } } }));
  const empty = await run('seller_items')({ user_id: '2214350705775' });
  assert.deepEqual([empty.count, empty.raw_cards, empty.has_more], [0, 0, false]);
  assert.deepEqual(empty.items, []);
  // Page 2 of a six-listing seller: SUCCESS, and `cardList` is ABSENT rather than empty. Measured live.
  // Treating that as a shape change was the first version's behaviour, and it made `page: 2` -- the most
  // ordinary call there is -- raise, because walking a pager is what `has_more` is for.
  use(makeSession({}, { items: { ok: true, ret: 'SUCCESS::调用成功', data: { itemGroupList: [], itemTopicList: [], nextPage: false, serverTime: 1, totalCount: 0 } } }));
  const past = await run('seller_items')({ user_id: '2214350705775', page: 2 });
  assert.deepEqual([past.count, past.raw_cards, past.has_more, past.page], [0, 0, false, 2]);
  assert.deepEqual(past.items, []);
  // A payload carrying none of the endpoint's own keys is not an empty page, it is something else, and
  // it has to say so rather than looking like a seller with nothing up.
  use(makeSession({}, { items: { ok: true, ret: 'SUCCESS::调用成功', data: { somethingElse: 1 } } }));
  await assert.rejects(run('seller_items')({ user_id: '2214350705775' }), (e: any) => e instanceof ParseError && /none of its own keys/.test(e.message));
  // The two ways this endpoint says a seller is not there, and both are named the same way rather than
  // as a throttle: page.head says USER_NOT_FOUND, this one says NOT_FOUND.
  use(makeSession({}, { items: { ok: false, ret: 'FAIL_BIZ_NOT_FOUND::||对方账号不存在', data: null } }));
  await assert.rejects(run('seller_items')({ user_id: '2255' }), (e: any) => e instanceof DetailUnavailableError && /对方账号不存在/.test(e.message));
  use(makeSession({}, { items: { ok: false, ret: 'FAIL_BIZ_FORBIDDEN::||最大可查看页数或者每页最大可查看商品数超限', data: null } }));
  await assert.rejects(run('seller_items')({ user_id: '2214350705775', page: 99 }), (e: any) => e instanceof GatedError && /50 pages of 20/.test(e.message));
  use(makeSession({}, { items: { ok: false, ret: 'RGV587_ERROR::SM::x', data: null } }));
  await assert.rejects(run('seller_items')({ user_id: '2214350705775' }), (e: any) => e instanceof GatedError && /RGV587/.test(e.message));
  // Cards with no id in any of them are dropped, which is what keeps a renamed `detailParams` from
  // silently shortening the list.
  use(makeSession({}, { items: { ok: true, ret: 'SUCCESS::调用成功', data: { cardList: [{ cardData: { title: 'x' } }], nextPage: false } } }));
  assert.equal((await run('seller_items')({ user_id: '2214350705775' })).count, 0);
});

test('seller_items page is bounded at the 50 goofish actually serves, not the shared 10,000', async () => {
  // Measured: page 50 SUCCESS, page 51 FAIL_BIZ_FORBIDDEN::||最大可查看页数或者每页最大可查看商品数超限,
  // and pageSize 30 refused at page 1. 50 pages of 20 is 1000 listings, which is the most a seller can
  // have, so a bound of 10,000 would only invite an agent to walk into a refusal.
  const cards = [sellerCard('1', 'x', '5')];
  const s = use(makeSession({}, { items: { ok: true, ret: 'SUCCESS::调用成功', data: { cardList: cards, nextPage: false } } }));
  assert.equal((await run('seller_items')({ user_id: '1', page: 9e9 as any })).page, 50);
  assert.equal(s.specs[0][0][2].pageNumber, 50);
  const json: any = z.toJSONSchema(z.object(TOOLS.find((t) => t.name === 'seller_items')!.schema), { io: 'input' });
  assert.equal(json.properties.page.maximum, 50, 'the published schema has to carry the bound goofish enforces');
  // And the label strip never publishes an icon name. free shipping arrives as a bare
  // `content: 'freeShippingIcon'` with no text, and the first version shipped it as a fact about the
  // listing -- found by a live run, not by a test.
  const tagCard = sellerCard('7', '包邮的东西', '9', { itemLabelDataVO: { labelData: { r1: { tagList: [{ data: { content: 'freeShippingIcon' } }, { data: { content: '验货宝' } }] } } } });
  use(makeSession({}, { items: { ok: true, ret: 'SUCCESS::调用成功', data: { cardList: [tagCard], nextPage: false } } }));
  assert.deepEqual((await run('seller_items')({ user_id: '1' })).items[0].tags, ['验货宝']);
});

test('seller_items given an item_id resolves the seller first, off the listing\'s own detail reply', async () => {
  const s = use(makeSession({ item: [UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [ok({
    itemDO: { itemId: '42', title: '男士羊毛呢大衣', soldPrice: '1999' },
    sellerDO: { sellerId: '2214350705775', nick: '汴梁资深化镁', city: '北京' },
  })] } }, { items: { ok: true, ret: 'SUCCESS::调用成功', data: { cardList: [sellerCard('765529563758', '安苏衬', '2550')], nextPage: false } } }));
  const out = await run('seller_items')({ item_id: '42' });
  assert.deepEqual(s.opened, ['https://www.goofish.com/item?id=42']);
  assert.deepEqual(s.specs[0][0][2], { needGroupInfo: true, pageNumber: 1, userId: '2214350705775', pageSize: 20 });
  assert.equal(out.item_id, '42');
  assert.equal(out.profile_url, 'https://www.goofish.com/personal?userId=2214350705775');
  // A listing whose detail reply carries no seller id has no seller to look up, and the message says
  // what to do instead rather than leaving the caller with a dead id. Cleared first: the lookup above
  // read this very listing in full and cached it, and a cache hit -- which asks goofish nothing -- would
  // find the seller the cached reply carried and never meet the no-seller reply at all.
  resetCaches();
  use(makeSession({ item: [UNRENDERED, UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [ok({ itemDO: { itemId: '42', title: 't' }, sellerDO: { nick: '无名氏' } })] } }));
  await assert.rejects(run('seller_items')({ item_id: '42' }), (e: any) => e instanceof DetailUnavailableError && /no readable seller/.test(e.message) && /user_id directly/.test(e.message));
});

test('the freshness answer does not wait for a browser, and never fakes a probe it did not run', async () => {
  // The defect (xi-cln): `build` -- which commit is answering, and is it behind main -- was returned
  // only AFTER the browser/mtop probes, so a caller asking "is this deploy current?" paid a measured
  // 60-90s cold Chromium launch for an answer that is a pure function of the build stamp, the base
  // ref and the checkout. Nobody can make a stale dist fresh by launching a browser, and a cold or
  // wedged Chromium is the slowest thing on the box.
  //
  // Proof is behavioural, not structural: a session that throws from every method cannot answer a
  // call that touched it, so a fast-path answer that came back at all is a fast path that launched
  // nothing. And the honesty half runs against the same fake -- a payload claiming a probe succeeded
  // when the fake would have thrown is the failure this split could have introduced.
  const s = use(makeSession({}, {}, 0));
  s.ensureReady = async () => { throw new BrowserError('chromium would have taken 90s to launch here'); };
  s.call = async () => { throw new BrowserError('mtop is not up'); };
  const fast = await run('capabilities')({ probe: false });
  // The question the gate actually asked, answered, with no browser in the process at all.
  assert.ok(fast.build, 'the build block is on the fast path -- that is the whole point');
  assert.equal(typeof fast.build.stale === 'boolean' || fast.build.stale === null, true);
  assert.equal(typeof fast.build.commit, 'string');
  assert.equal(typeof fast.build.behind === 'number' || fast.build.behind === null, true);
  // ...and the rest of the payload is still whole. Splitting the response is not dropping half of it.
  assert.ok(Array.isArray(fast.works_without_account) && fast.works_without_account.length > 0);
  assert.ok(Array.isArray(fast.notes) && fast.notes.length > 0 && fast.note);
  assert.equal(fast.requires_xianyu_account, false);
  assert.ok(fast.cache, 'the cache block is on the fast path too');
  assert.equal(fast.probes.ran, false);
  // The honesty half. `feed_reachable: false` here would assert the feed did not answer, when the
  // truth is nobody asked -- and a freshness gate that trusted it would report a live server as
  // unreachable. Null, and named.
  assert.deepEqual([fast.session_state, fast.login_probe_ret, fast.feed_reachable, fast.browser_launches], [null, null, null, null]);
  assert.deepEqual(fast.probes.not_measured, ['session_state', 'login_probe_ret', 'feed_reachable', 'browser_launches']);
  assert.deepEqual(fast.probes.measured, [], 'nothing was measured, so nothing is claimed');
  assert.match(fast.probes.note, /nobody looked, NOT because a probe failed/);
  // no per-probe error keys either: a probe that did not run has not errored
  assert.deepEqual([fast.browser_error, fast.login_error, fast.feed_error], [undefined, undefined, undefined]);
  // Same build answer either way -- the split is about WHEN, and two paths that could disagree about
  // staleness would be a worse bug than the latency this fixes.
  const deep = use(makeSession({}, { me: { ok: false, ret: 'FAIL_SYS_SESSION_EXPIRED::x' }, f: { ok: true } }));
  const probed = await run('capabilities')({});
  assert.deepEqual(fast.build, probed.build, 'the freshness answer does not depend on the probes at all');
  assert.deepEqual(fast.cache, probed.cache);
  // and the default still probes: existing callers lose nothing
  assert.equal(probed.probes.ran, true);
  assert.deepEqual(probed.probes.measured, ['session_state', 'login_probe_ret', 'feed_reachable', 'browser_launches']);
  assert.deepEqual(probed.probes.not_measured, []);
  assert.equal(probed.session_state, 'logged_out');
  assert.equal(probed.feed_reachable, true);
  assert.equal(typeof probed.browser_launches, 'number');
  // even against a dead browser, which is the case the bead says once looked like a hang
  deep.ensureReady = async () => { throw new BrowserError('chromium is gone'); };
  const deadFast = await run('capabilities')({ probe: false });
  assert.equal(deadFast.probes.ran, false, 'a dead browser cannot deny the freshness answer');
  assert.equal(typeof deadFast.build.commit, 'string');
  assert.equal(deadFast.session_state, null);
});

test('capabilities never throws, not even when the browser is gone, and a failed probe does not hide the others', async () => {
  const s = use(makeSession({}, { me: { ok: false, ret: 'FAIL_SYS_SESSION_EXPIRED::x' }, f: { ok: true } }));
  const ok = await run('capabilities')({});
  assert.equal(ok.requires_xianyu_account, false);
  assert.equal(ok.session_state, 'logged_out');
  assert.equal(ok.login_probe_ret, 'FAIL_SYS_SESSION_EXPIRED::x');
  assert.equal(ok.feed_reachable, true);
  // every tool it names in works_without_account is a tool that exists
  for (const line of ok.works_without_account) {
    for (const word of line.split(/[^a-z_]+/)) if (word.includes('_')) assert.ok(TOOLS.some((t) => t.name === word), `works_without_account names ${word}, which is not a tool`);
  }
  assert.ok(ok.anonymous_flakiness.length > 0 && ok.notes.length > 0 && ok.note);
  // merged into one try, a throwing loginuser probe skipped the feed probe and its verdict, and the
  // whole thing looked like a dead browser; each probe now reports under its own key
  s.call = async () => { throw new BrowserError('mtop is not up'); };
  const partial = await run('capabilities')({});
  assert.equal(partial.session_state, 'unknown');
  assert.equal(partial.feed_reachable, false);
  assert.equal(partial.login_error, 'BrowserError: mtop is not up');
  assert.equal(partial.feed_error, 'BrowserError: mtop is not up');
  assert.equal(partial.browser_error, undefined, 'the browser was fine; only the calls failed');
  s.ensureReady = async () => { throw new BrowserError('chromium is gone'); };
  const broken = await run('capabilities')({});
  assert.equal(broken.session_state, 'unknown');
  assert.equal(broken.browser_error, 'BrowserError: chromium is gone');
  assert.ok(broken.notes.length > 0, 'the lists are still there when the probes fail');
  // even a null throw is reported rather than rethrown: `(e as Error).constructor.name` is a TypeError
  s.ensureReady = async () => { throw null; };
  assert.match(String((await run('capabilities')({})).browser_error), /^(Error|TypeError):/);
  s.ensureReady = async () => { throw new Error('something unexpected'); };
  assert.ok(await run('capabilities')({}));
  // session_state is the conclusion this tool exists to draw, so it is not drawn from "the probe
  // failed": a rate limit and a timeout say nothing about whether a session exists.
  for (const [ret, want] of [['RGV587_ERROR::挤爆啦', 'unknown'], ['FAIL_SYS_COMMON::TIMEOUT', 'unknown'], ['', 'unknown'], ['FAIL_SYS_TOKEN_EXPIRED::x', 'logged_out'], ['SUCCESS::调用成功', 'unexpectedly_logged_in']] as const) {
    use(makeSession({}, { me: { ok: ret.startsWith('SUCCESS'), ret }, f: { ok: true } }));
    assert.equal((await run('capabilities')({})).session_state, want, ret || '(empty ret)');
  }
});

test('a repeat item_view is answered from the cache, with no page load, and publishes the age', async () => {
  // The sequence this exists for: search, open a result, open it again. The second read costs a page
  // load (4-10s measured) to produce the same listing, so it is served from what this process already
  // read -- and the session it would have asked is one that cannot answer, so a hit that quietly went
  // to the wire would fail here rather than merely being slower.
  const reply = ok({ itemDO: { itemId: '42', title: '男士羊毛呢大衣', soldPrice: '1999', desc: '专柜入手', wantCnt: 1, browseCnt: 34 }, sellerDO: { nick: '汴梁', city: '北京', userRegDay: 2256 } });
  use(makeSession({ item: [UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [reply] } }));
  const first = await run('item_view')({ item_id: '42' });
  assert.equal(first.source, 'item_detail_api');
  // The miss publishes the same block as the hit, so the envelope does not change shape with the route
  assert.deepEqual([first.cache.hit, first.cache.key, first.cache.age_s, first.cache.stored_at], [false, 'item:42', null, null]);
  assert.match(first.cache.note, /goofish answered it live just now/);
  assert.equal(first.attempts, 1, 'one page load did the work');

  const blind = use(makeSession({ item: [UNRENDERED] }));   // no detail reply on offer: a live read cannot answer
  const second = await run('item_view')({ item_id: '42' });
  assert.equal(blind.opened.length, 0, 'no page was loaded at all');
  assert.equal(second.source, 'item_detail_api');
  assert.equal(second.title, '男士羊毛呢大衣', 'the same listing, not a card and not nothing');
  assert.equal(second.attempts, 0, 'and it says so rather than implying a load happened');
  assert.equal(second.cache.hit, true);
  assert.equal(typeof second.cache.age_s, 'number');
  assert.equal(second.cache.ttl_s, 45, 'the window this listing may be served for');
  assert.match(second.cache.note, /goofish was not asked/);
  assert.match(second.cache.note, /sold, repriced or edited since/);
  // A different listing is not served from this one's entry, and a listing nobody has read still asks.
  const other = use(makeSession({ item: [UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [ok({ itemDO: { itemId: '43', title: '别人的东西', soldPrice: '9' }, sellerDO: {} })] } }));
  assert.equal((await run('item_view')({ item_id: '43' })).cache.hit, false);
  assert.equal(other.opened.length, 1);
  // XIANYU_CACHE=0 is the escape hatch: the same call now goes to the wire, and the blind session is
  // the proof that it does.
  process.env.XIANYU_CACHE = '0';
  const live = use(makeSession({ item: [UNRENDERED] }));
  await assert.rejects(run('item_view')({ item_id: '42' }), DetailUnavailableError);
  assert.equal(live.opened.length, 1, 'the page was loaded for a live read');
  delete process.env.XIANYU_CACHE;
});

test('a repeat search is answered from the cached pages, with no page, no keystroke and no mtop call', async () => {
  // The expensive half of search is the page load and the pager walk: 15-41s cold, 4-12s warm, and
  // 5-9.5s a page on top. A search whose (query, page) set this process already walked has none of
  // that to pay, and the session below cannot serve a search at all -- so a hit that went to the wire
  // would raise SearchUnavailableError rather than merely taking longer.
  const c = searchCase('x220', [['联想Thinkpad X220 笔记本电脑', '856961429564', '329', '北京', '5'], ['X220 屏幕总成', '856961429565', '199', '上海', '2']]);
  use(makeSession({ cards: [c.rows], mtop: c.mtop }));
  const first = await run('search_items')({ query: 'x220', limit: 5, attempts: 1 });
  assert.equal(first.source, 'search_api');
  assert.equal(first.cache.hits, 0, 'nothing was cached before the first call');
  assert.deepEqual(first.cache.pages, [{ page: 1, hit: false, age_s: null }]);

  const blind = use(makeSession());
  const second = await run('search_items')({ query: 'x220', limit: 5, attempts: 1 });
  assert.equal(blind.opened.length, 0, 'no page was loaded and no query was typed');
  assert.equal(blind.specs.length, 0, 'and no mtop call was made');
  assert.equal(second.via, 'cache', 'the envelope says the answer did not come from goofish');
  assert.equal(second.attempts, 0);
  assert.equal(second.count, first.count, 'the same matches, through the same relevance guard');
  assert.deepEqual(second.items.map((i: any) => i.item_id), first.items.map((i: any) => i.item_id));
  assert.equal(second.cache.hits, 1);
  assert.equal(second.cache.pages[0].hit, true);
  assert.equal(typeof second.cache.pages[0].age_s, 'number');
  assert.match(second.attempt_log[0].note, /already cached/);
  // ...and the same query in a different case is the *same* search, served from the same entry: the
  // key is lowercased precisely because the guard it is pooled through matches titles
  // case-insensitively, so keying on the raw string would store one page twice and serve half of it
  // never. (That this is a hit is the point; `searchKey` has its own test.)
  const cased = use(makeSession());
  const third = await run('search_items')({ query: 'X220', limit: 5, attempts: 1 });
  assert.equal(third.via, 'cache');
  assert.equal(cased.opened.length, 0);
  assert.deepEqual(third.items.map((i: any) => i.item_id), first.items.map((i: any) => i.item_id));
  // ...while a query nobody asked is a different question, and is asked
  const rows2 = [['X220 屏幕总成', '856961429565', '199', '上海', '2']];
  const other = use(makeSession({ cards: [searchCase('x220 屏幕', rows2).rows], mtop: searchCase('x220 屏幕', rows2).mtop }));
  const fourth = await run('search_items')({ query: 'x220 屏幕', limit: 5, attempts: 1 });
  assert.equal(fourth.cache.hits, 0);
  assert.equal(fourth.via, 'searchbox');
  assert.equal(other.opened.length, 1, 'a query that was never asked is asked');
});

test('a deeper search reuses the pages it has and only walks the new ones', async () => {
  // The pool is 10 a page here so the guard and the walk are both visible. A second call for one page
  // deeper has page 1 and page 2 in hand and must not click the pager for them again -- each click is
  // 5-9.5s, so this is where the cache pays rather than the whole-call fast path above.
  const page = (n: number) => ok(searchReply('x220', Array.from({ length: 10 }, (_, i) => [`联想 X220 ${n}-${i}`, String(n * 100 + i), '50', '北京', '1'])));
  const s = use(makeSession({ mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [page(1), page(2), page(3)] } }));
  s.runRealNormalizer = true;
  const first = await run('search_items')({ query: 'x220', pages: 2, limit: 20, attempts: 1 });
  assert.equal(first.pages_fetched, 2);
  assert.deepEqual(s.pagers, ['2']);

  // Only two replies are on offer here, and that is the fixture doing the asserting: this call asks
  // goofish for page 1 and page 3 and takes page 2 from the cache, so if it were also fetching page 2
  // the second reply would land on page 3's slot and the pool would be 30 cards of 20 distinct ids.
  const s2 = use(makeSession({ mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [page(1), page(3)] } }));
  s2.runRealNormalizer = true;
  const deeper = await run('search_items')({ query: 'x220', pages: 3, limit: 20, attempts: 1 });
  // Page 1 was asked for again -- it is the keystroke that gets the process to the pager at all -- and
  // then only page 3 was clicked, because page 2 was already in hand.
  assert.deepEqual(s2.pagers, ['3'], 'the cached page was not walked again');
  assert.equal(deeper.cache.hits, 1);
  assert.deepEqual(deeper.cache.pages.map((p: any) => [p.page, p.hit]), [[1, false], [2, true], [3, false]]);
  assert.match(deeper.cache.note, /1 of 3 page\(s\)/);
  const reused = deeper.attempt_log.find((e: any) => e.cache === 'hit');
  assert.equal(reused.pager, 2, 'and the log names the page that came from the cache');
  // The pooled set is judged as one set, cached and live pages alike, so a cached page cannot smuggle
  // a weak result past the fraction the live pages have to pass.
  assert.equal(deeper.scraped_cards, 30);
  assert.equal(deeper.count > 0, true);
});

test('`detail` reports which of its listings came from the cache rather than a page load', async () => {
  const rows = Array.from({ length: 4 }, (_, i) => [`联想 X220 ${i}`, String(300 + i), '100', '北京', '2']);
  const c = searchCase('x220', rows);
  const detail = (id: string) => ok({ itemDO: { itemId: id, title: `详情 ${id}`, soldPrice: '123', desc: '成色好' }, sellerDO: { nick: '卖家', city: '北京' } });
  const one = { cards: [c.rows], mtop: { 'mtop.taobao.idlemtopsearch.pc.search': c.mtop['mtop.taobao.idlemtopsearch.pc.search'], 'mtop.taobao.idle.pc.detail': [detail('300')] } };
  use(makeSession(one));
  const cold = await run('search_items')({ query: 'x220', detail: 1, limit: 4, attempts: 1 });
  assert.equal(cold.detail_report[0].cached, false, 'the first read of a listing is never a cache hit');
  assert.equal(cold.detail_report[0].cache_age_s, null);
  // The search pages are cached, so the second call answers without typing; the listing was read in
  // full a moment ago, so its detail read is served too -- and both facts are published.
  const blind = use(makeSession());
  const warm = await run('search_items')({ query: 'x220', detail: 1, limit: 4, attempts: 1 });
  assert.equal(blind.opened.length, 0);
  assert.equal(warm.detail_report[0].ok, true);
  assert.equal(warm.detail_report[0].cached, true, 'and the report says which of the listings were read live');
  assert.equal(typeof warm.detail_report[0].cache_age_s, 'number');
  const first = warm.items.find((i: any) => i.item_id === '300');
  assert.equal(first.cached, true, 'the listing itself carries it, not only the report');
  assert.equal(first.description, '成色好', 'and the detail fields are the ones read from goofish, not from the card');
});

test('tool calls are serialised, so two in flight cannot navigate one page out from under the other', async () => {
  const order: string[] = [];
  const slow = (tag: string, ms: number) => exclusive(async () => { order.push(`${tag}:in`); await new Promise((r) => setTimeout(r, ms)); order.push(`${tag}:out`); return tag; });
  assert.deepEqual(await Promise.all([slow('a', 20), slow('b', 1)]), ['a', 'b']);
  assert.deepEqual(order, ['a:in', 'a:out', 'b:in', 'b:out']);
  // a rejected tool releases the lock rather than wedging every call after it
  await assert.rejects(exclusive(async () => { throw new XianyuError('boom'); }), XianyuError);
  assert.equal(await exclusive(async () => 'after'), 'after');
});

test('compact search returns one line per listing with the fields a scan needs, and the default is still an object', async () => {
  const c = searchCase('x220', [['联想 X220 笔记本电脑', '4242', '99', '北京', '7']]);
  use(makeSession({ cards: [c.rows], mtop: c.mtop }));
  const full = await run('search_items')({ query: 'x220', limit: 1 });
  assert.equal(typeof full.items[0], 'object', 'the default stays an object');
  use(makeSession({ cards: [c.rows], mtop: c.mtop }));
  const compact = await run('search_items')({ query: 'x220', limit: 1, compact: true });
  assert.equal(typeof compact.items[0], 'string', 'compact returns a line');
  const line = compact.items[0];
  assert.match(line, /^1 \| 4242 \| ¥99/, 'rank, id and price lead the line');
  assert.match(line, /想要7/, 'the want count is in the line');
  assert.match(line, /北京/, 'the city is in the line');
  assert.match(line, /联想 X220 笔记本电脑$/, 'the title ends the line');
});
