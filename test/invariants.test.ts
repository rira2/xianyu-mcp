/**
 * The server's central promises, as invariants over the source: no Xianyu account, no
 * credentials, no write capability, navigation confined to goofish.com, and no invented
 * data. These are cheap and they are the tests that would catch a bad change nobody
 * thought about -- so they scan the whole tree rather than asserting on one function.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BOOT_URL, ensureGoofishUrl, HOME } from '../src/browser.ts';
import { ITEM_SCRAPE_JS, RAIL_MARKERS } from '../src/extract.ts';
import { BrowserError, DetailUnavailableError, describe, GatedError, NavigationError, ParseError, PUBLISHED_ERROR_TYPES, SearchUnavailableError, XianyuError } from '../src/errors.ts';
import { TOOLS } from '../src/tools.ts';
import { z } from 'zod';

const ROOT = join(import.meta.dirname, '..');
const sources = ['src', 'test'].flatMap((dir) => readdirSync(join(ROOT, dir), { recursive: true })
  .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts'))
  .map((f) => join(ROOT, dir, f)));
// Read once at module scope: four tests scan the same files, and re-reading and re-splitting them
// per test is the only thing that made this suite slow.
const SRC: Record<string, string> = Object.fromEntries(sources.map((p) => [p, readFileSync(p, 'utf8')]));
const read = (p: string) => SRC[p] ?? readFileSync(p, 'utf8');

/** A line that is only naming the needle (this file's own lists) or narrating it. */
const isJustNamingIt = (line: string) => /^['"`/*-]/.test(line.trim());
/** `!` and `?.` sit between the object and the call, so a real `context.cookies()`
 *  read is usually written `context!.cookies()`. Normalise them away first. */
const deAsserted = (line: string) => line.replace(/[!?]+\./g, '.');
const flat = (line: string) => deAsserted(line).replace(/\s+/g, '');

test('no credential access anywhere in the tree', () => {
  // The tree is pinned by name, not by a count: a scan that silently stops covering a file -- or one
  // that silently starts covering a sixth source file -- is the failure mode here, not a raw credential.
  // build.ts and build-info.ts are in the list deliberately: they read the filesystem and shell out to
  // git, which is the only place in src/ that touches anything outside the goofish session, so the
  // credential scan below has to be able to see them. `src/cache.ts` is in it for the same reason one
  // layer down: a module that holds what this server has read off goofish is exactly the module the
  // scans must cover, and a scan that quietly does not cover it is worse than no scan.
  assert.deepEqual(sources.map((p) => p.replace(`${ROOT}/`, '')).sort(), ['src/browser.ts', 'src/build-info.ts', 'src/build.ts', 'src/cache.ts', 'src/errors.ts', 'src/extract.ts', 'src/index.ts', 'src/tools.ts', 'test/build-info.test.ts', 'test/cache.test.ts', 'test/check-deploy.test.ts', 'test/extract.test.ts', 'test/invariants.test.ts', 'test/serve.test.ts', 'test/tools.test.ts']);
  // `.cookies(` rather than `context.cookies(`, and matched with the whitespace stripped: matching
  // the literal missed `page.context().cookies()` and any call split across lines.
  const forbidden = [
    '.cookies(', 'storageState', 'launchPersistentContext', 'userDataDir',
    'cookie2', 'sgcookie', 'x5sec', '_m_h5_tk', 'addCookies', 'localStorage', 'sessionStorage',
  ];
  const offenders: string[] = [];
  for (const p of sources) {
    read(p).split('\n').forEach((line, i) => {
      const flat = deAsserted(line).replace(/\s+/g, '');
      for (const needle of forbidden) if (flat.includes(needle) && !isJustNamingIt(line)) offenders.push(`${p}:${i + 1} ${needle}`);
    });
  }
  assert.deepEqual(offenders, []);
  // and the scan really does catch that shape, which is what a credential read looks like
  assert.equal(flat(['page.context()', '  .' + 'cookies()'].join('\n')).includes('.' + 'cookies('), true);
});

test('only the eight read-only mtop APIs are named anywhere: a closed list, so a new one cannot slip in', () => {
  const readApis = [
    'mtop.taobao.idlehome.home.webpc.feed',
    'mtop.taobao.idle.filter.hitnum.pc.get',
    'mtop.taobao.idle.item.web.recommend.list',
    'mtop.taobao.idlemessage.pc.loginuser.get',
    // The last two are never called by us -- they are named because the *page* calls them and
    // item_view / search_items read the replies off the wire. Re-issuing either through the page's
    // own mtop client answers TIMEOUT, because goofish stamps the calls its bundle originates with a
    // per-call anti-bot blob. See `MtopTap`.
    'mtop.taobao.idle.pc.detail',
    'mtop.taobao.idlemtopsearch.pc.search',
    // These two are the other side of that rule, and the list is the place the asymmetry has to stay
    // visible. goofish stamps only the calls its OWN bundle originates, so an endpoint the current page
    // never happens to use can be issued through the very same client and answers normally -- measured,
    // `page.head` SUCCESS from an item page that never calls it. That is why a seller profile is
    // reachable at all, and why intercepting responses could never have found it.
    'mtop.idle.web.user.page.head',
    'mtop.idle.web.xyh.item.list',
  ];
  assert.equal(readApis.length, 8);
  // `window.lib.mtop.request` is the page's own client method -- the one call this server is built
  // on -- not an API name. Everything else shaped like `mtop.<something>` is an API and is closed.
  const notAnApi = 'mtop.request';
  const seen = new Set<string>();
  const offenders: string[] = [];
  for (const p of sources) {
    read(p).split('\n').forEach((line, i) => {
      if (isJustNamingIt(line)) return;
      for (const api of deAsserted(line).match(/mtop\.[A-Za-z0-9_.]+/g) ?? []) {
        if (api === notAnApi) continue;
        seen.add(api);
        if (!readApis.includes(api)) offenders.push(`${p}:${i + 1} ${api}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
  // every one of the nine is actually reached, not just allowed
  assert.deepEqual([...seen].sort(), [...readApis].sort());
  // and the pattern really is closed over the whole namespace, which the old two-namespace version
  // was not: a write API outside taobao/idle would have passed it. (Built by concatenation so that
  // this line does not flag itself -- the scan reads this file too.)
  const write = 'mtop.' + 'commerce.item.publish';
  assert.deepEqual(write.match(/mtop\.[A-Za-z0-9_.]+/g), [write]);
});

test('exactly the ten read-only tools exist, and none of them can change state', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['browse_feed', 'capabilities', 'item_view', 'related_items', 'search_count', 'search_items', 'seller_items', 'seller_profile']);
  for (const t of TOOLS) {
    assert.equal(/publish|delete|remove|message|send|upload|comment|order|buy|checkout|follow|favou?rite/i.test(t.name), false, `${t.name} looks like a write tool`);
  }
});

test('the two seller tools take the shared lock only for the item-page hop, and never as a blanket', () => {
  // The two-page session exists so a 70s search does not hold up a 1.5s feed call, and the promise is
  // kept by wrapping the tools that read the one navigating page. `seller_profile` and `seller_items`
  // are the awkward case and the reason the rule is "where a page is read" rather than a tool list:
  // given a user_id they are one mtop call each, and given an item_id they must read the item page's
  // own detail reply to learn who the seller is. Wrapping them whole would queue two cheap calls behind
  // every search; not locking the hop at all would let them navigate the dom page under a search's feet.
  const toolsSrc = read(join(ROOT, 'src', 'tools.ts'));
  for (const name of ['sellerProfile', 'sellerItems']) {
    assert.equal(new RegExp(`run: locked\\(${name}\\)`).test(toolsSrc), false, `${name} is wrapped in the blanket lock; that re-serialises a one-call mtop lookup behind every search`);
    assert.equal(new RegExp(`run: ${name}\\b`).test(toolsSrc), true, `${name} must be registered unwrapped`);
  }
  // The scoped lock is inside `resolveSeller`, and it wraps the page read rather than the whole tool.
  const resolver = toolsSrc.match(/const resolveSeller = [\s\S]*?\n};/)?.[0] ?? '';
  assert.match(resolver, /exclusive\(\(\) => readListing\(/, 'the item-page hop must take the shared lock');
  // ...and nothing else in either tool does, which is the half that is easy to lose to a later edit.
  for (const name of ['sellerProfile', 'sellerItems']) {
    const body = toolsSrc.match(new RegExp(`const ${name} = async[\\s\\S]*?\\n};`))?.[0] ?? '';
    assert.equal(/exclusive\(/.test(body), false, `${name} takes a lock of its own; the only page read either makes is resolveSeller's, which takes the shared one`);
  }
  // Both still route every mtop call through the session, so nothing reaches the wire except through
  // browser.ts -- the one place the allowlist and the "no new mandatory browser launch" budget live.
  for (const name of ['sellerProfile', 'sellerItems']) {
    const body = toolsSrc.match(new RegExp(`const ${name} = async[\\s\\S]*?\\n};`))?.[0] ?? '';
    assert.match(body, /session\.call\(/, `${name} must go through the shared session rather than issuing its own request`);
    assert.equal(/\bpage\.evaluate\(/.test(body), false, `${name} has no in-page script; its payload comes back from one mtop call`);
  }
});

test('the detail fan-out is reachable only from inside the lock its caller already holds', () => {
  // `detail`'s fan-out loads two listing pages at a time, and the thing that keeps that safe is not a
  // lock of its own -- it is that it runs *inside* `search_items`, which is already wrapped in the
  // shared lock. A second search, an `item_view` and a `recommendations` call therefore cannot be in
  // flight beside a fan-out, and the pool pages are invisible to every other tool. That property is
  // entirely about where this is called from, so it is asserted here rather than trusted: the fan-out
  // has exactly one caller, that caller has exactly two call sites, and both are inside the tool that
  // holds the lock.
  const toolsSrc = read(join(ROOT, 'src', 'tools.ts'));
  const fanout = toolsSrc.match(/const enrichDetails = [\s\S]*?\n};/)?.[0] ?? '';
  assert.match(fanout, /session\.fanoutSurface\(/, 'the fan-out leases its pages from the session');
  assert.equal((toolsSrc.match(/enrichDetails\(/g) ?? []).length, 1, 'exactly one call site');
  assert.equal((toolsSrc.match(/publishSearch\(/g) ?? []).length, 2, 'and exactly two call sites for its publisher');
  assert.equal((toolsSrc.match(/session\.fanoutSurface\(/g) ?? []).length, 1, 'so nothing else leases a pool page');
  // both routes into a pooled answer -- the cache fast path and the live walk -- go through that one
  // publisher, so there is no way to reach the fan-out that skips the lock
  const search = toolsSrc.match(/const searchItems = async[\s\S]*?\n};/)?.[0] ?? '';
  assert.equal((search.match(/publishSearch\(/g) ?? []).length, 2, 'both are inside search_items');
  assert.match(toolsSrc, /run: locked\(searchItems\)/, 'and the tool that reaches it holds the shared lock');
  // The fallback is not a silent one: the fan-out either ran or says why it did not, and both are in
  // the envelope rather than in a comment above this function.
  assert.match(fanout, /fellBack/, 'the answer-rate check is in the loop, not beside it');
  assert.match(toolsSrc, /readFromGoofish/, 'and the check reads what goofish answered, not whether a card was returned');
});

test('every tool says that no account is required, and that it is read-only', () => {
  for (const t of TOOLS) {
    assert.match(t.description, /No Xianyu account/, t.name);
    assert.match(t.description, /Read-only/, t.name);
    assert.ok(t.description.length > 80, `${t.name} needs a description an agent can act on`);
  }
});

test('the entry point does not serialise the tools: the lock belongs to the three DOM tools only', () => {
  // The regression guard for a defect that shipped: index.ts wrapped *every* tool in `exclusive()`,
  // so the four mtop-only tools queued behind a 70s search -- exactly the latency the two-page
  // session exists to remove -- while browser.ts's own comment claimed they did not. Nothing failed,
  // because the test that "proved" it called `t.run` directly and hand-wrapped the search itself.
  // Read the source, because the property is about the entry point, not about any one tool's runtime.
  const entry = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
  assert.equal(/exclusive/.test(entry), false, 'index.ts must not take the lock; tools.ts owns it. Re-wrapping all ten re-serialises the fast tools behind every slow one.');
  // ...and the lock really is on the three DOM tools, so the promise is kept rather than deleted.
  const toolsSrc = readFileSync(join(ROOT, 'src', 'tools.ts'), 'utf8');
  for (const name of ['searchItems', 'itemView']) {
    assert.match(toolsSrc, new RegExp(`run: locked\\(${name}\\)`), `${name} reads the shared navigating page and must take the lock`);
  }
  for (const name of ['browseFeed', 'searchCount', 'relatedItems', 'capabilities']) {
    assert.equal(new RegExp(`run: locked\\(${name}\\)`).test(toolsSrc), false, `${name} never touches the dom page; locking it only adds latency`);
  }
});

test('the advertised version is read from package.json, not written down a second time', () => {
  // The entry point used to carry `version: '0.1.0'` as a literal beside package.json's own "0.1.0".
  // Nothing compared them, so `npm version` would bump the package and leave every MCP client being
  // told the previous release existed. Asserted over the source rather than at runtime because the
  // property is that there is no second copy to fall out of step -- importing index.ts would start
  // the stdio server.
  const idx = read(join(ROOT, 'src', 'index.ts'));
  assert.match(idx, /createRequire\(import\.meta\.url\)\('\.\.\/package\.json'\)/, 'the version must come from package.json');
  const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as { version: string };
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, `package.json version looks wrong: ${pkg.version}`);
  assert.match(idx, /new McpServer\(\{ name: 'xianyu', version \}/, 'the handshake must use the value it just read');
  // No literal semver anywhere in src/: that is the shape the drift took.
  for (const p of sources.filter((f) => f.includes(`${ROOT}/src/`))) {
    const literal = SRC[p].match(/version: ['"]\d+\.\d+\.\d+['"]/);
    assert.equal(literal, null, `${p.replace(`${ROOT}/`, '')} writes down a version literal (${literal?.[0]})`);
  }
});

test('the published argument names and defaults are exactly these', () => {
  const shape = (t: (typeof TOOLS)[number]) => Object.fromEntries(Object.entries(t.schema).map(([k, v]: [string, any]) => {
    const parsed = v.safeParse(undefined);
    if (!parsed.success) return [k, '<required>'];
    return [k, parsed.data === undefined ? '<optional>' : parsed.data];
  }));
  const published: Record<string, any> = {
    // `probe: true` by default, and it exists at all so the freshness answer does not have to wait
    // for a browser launch -- see capabilities in tools.ts.
    capabilities: { probe: true },
    browse_feed: { page_number: 1, pages: 1, limit: 60 },
    search_count: { query: '<required>' },
    search_items: { query: '<required>', limit: 120, attempts: 4, pages: 1, detail: 0, compact: false },
    related_items: { item_id: '<optional>', limit: 30, page: 1 },
    item_view: { item_id: '<required>' },
    // Both seller tools take two alternatives and neither is required: which one is missing is the
    // question, and a schema that forced one would push the "give exactly one of these" message into
    // every caller's error handling instead of the envelope.
    seller_profile: { user_id: '<optional>', item_id: '<optional>' },
    seller_items: { user_id: '<optional>', item_id: '<optional>', limit: 20, page: 1 },
  };
  assert.deepEqual(Object.fromEntries(TOOLS.map((t) => [t.name, shape(t)])), published);
  // and bounded where the agent can see it. `related_items.page` was the one number in the contract
  // with no ceiling at all, so the served JSON Schema invited page 1e9.
  for (const t of TOOLS) {
    const json: any = z.toJSONSchema(z.object(t.schema), { io: 'input' });
    for (const [k, v] of Object.entries<any>(json.properties ?? {})) {
      if (v.type !== 'number' && v.type !== 'integer') continue;
      // zod fills an unbounded number in with JSON Schema's own limits, so "has a maximum" is not the
      // question -- "has a bound somebody chose" is, and only a stricter one counts.
      assert.ok(v.minimum > -Number.MAX_SAFE_INTEGER && v.maximum < Number.MAX_SAFE_INTEGER, `${t.name}.${k} is unbounded in the published schema`);
    }
  }
});

test('every navigation goes through browser.ts, so there is exactly one place to audit', () => {
  for (const p of sources.filter((f) => f.includes('src') && !f.endsWith('browser.ts'))) {
    const hits = read(p).split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => l.includes('.goto(') || l.includes('.reload('));
    assert.deepEqual(hits, [], `${p} navigates outside browser.ts`);
  }
});

test('both navigation sites re-check the URL, before and after the redirect', () => {
  const src = read(join(ROOT, 'src', 'browser.ts'));
  const [load] = src.match(/async function load\([\s\S]*?\n}/) ?? [];
  assert.ok(load && load.includes('page.goto('), 'the one place a chosen URL is loaded from');
  // loadInto is the one function that navigates a page a caller owns, and open() (the shared dom page)
  // and fanoutSurface() (a fan-out slot's own page) both go through it. That is the shape the ordering
  // assertions below are about: there is a single navigation site, so a second one that forgot the
  // allowlist cannot be written -- and the two entry points are checked to still be delegating, since
  // the failure mode of this refactor is a third site growing beside it rather than the check moving.
  const site = src.match(/private async loadInto\([\s\S]*?\n  }/)?.[0] ?? '';
  // before the goto, after it, and once more on the way out: the settle and the mtop wait after the
  // second check can take tens of seconds, so the check that is still current when the caller scrapes
  // is the last.
  assert.ok((site.match(/ensureGoofishUrl\(/g) ?? []).length >= 3, site);
  assert.ok(site.indexOf('ensureGoofishUrl(url)') < site.indexOf('load(page, target)'));
  assert.ok(site.indexOf('load(page, target)') < site.indexOf('ensureGoofishUrl(page.url())'));
  assert.ok(site.lastIndexOf('ensureGoofishUrl(page.url())') > site.indexOf('waitForMtop(page)'), site);
  // the fan-out's page is a page like any other: it gets the same checks, not a cheaper navigation
  const lease = src.match(/async fanoutSurface\([\s\S]*?\n  }/)?.[0] ?? '';
  assert.match(lease, /this\.loadInto\(/, 'the fan-out must navigate through the one checked site');
  assert.equal(/load\(page|\.goto\(|\.reload\(/.test(lease), false, 'and must not navigate on its own');
  const open = src.match(/async open\([\s\S]*?\n  }/)?.[0] ?? '';
  assert.match(open, /this\.loadInto\(/, 'open must navigate through the one checked site');
  // and the fan-out's bound is a refusal rather than a clamp: a slot past the measured width is an error
  assert.match(src.match(/async fanoutSurface\([\s\S]*?\n  }/)?.[0] ?? '', /DETAIL_POOL_MAX/);
  // reloadFresh re-validates wherever the page ended up, which is not something we chose, and it
  // does not swallow that refusal: its three callers scrape whatever is on the page next.
  const fresh = src.match(/async function reloadFresh\([\s\S]*?\n}/)?.[0] ?? '';
  assert.match(fresh, /ensureGoofishUrl\(page\.url\(\)/);
  assert.equal(fresh.trim().split('\n').pop(), '}', 'the allowlist check has to be the last thing it does');
  // revive, the third navigation site, decides with the same check rather than a prefix test
  assert.match(src.match(/private parkedOnGoofish[\s\S]*?\n}/)?.[0] ?? '', /ensureGoofishUrl\(page\.url\(\)\)/);
  assert.match(src.match(/private async revive[\s\S]*?\n  }/)?.[0] ?? '', /parkedOnGoofish\(live\)/);
  assert.equal(/\.url\(\)\.startsWith\(/.test(src), false, 'the startsWith check that let www.goofish.computer through is back');
  // Those checks are all point-in-time, and every caller then polls for seconds before it reads the
  // DOM. So tools.ts reads the DOM through one helper that re-checks the URL that is live *now*, in
  // the same statement as the read, and no scraper may reach `evaluate` around it.
  const tools = read(join(ROOT, 'src', 'tools.ts'));
  const helper = tools.match(/const scrape = .*/)?.[0] ?? '';
  assert.match(helper, /ensureGoofishUrl\(page\.url\(\)\); return evaluate\(/, 'the re-check has to be the statement immediately before the read');
  for (const js of ['SCRAPE_CARDS_JS', 'ITEM_SCRAPE_JS']) {
    assert.ok(tools.includes(`scrape(page, ${js}`), `${js} never goes through the re-checking helper`);
    assert.equal(new RegExp(`evaluate\\(page, ${js}`).test(tools), false, `${js} bypasses the re-check`);
  }
  // What is left calling `evaluate` with a page must be the scripts that read no page data: the feed
  // normalizer (a pure function over cards we already hold) and the gallery nudge (a scrollTo).
  const direct = [...tools.matchAll(/evaluate\(page, (\w+)/g)].map((m) => m[1]).filter((n) => n !== 'fn');
  assert.deepEqual([...new Set(direct)].sort(), ['FEED_NORMALIZE_JS', 'SCROLL_TO_JS'], 'a script that reads the DOM may not skip the re-check');
});

test('navigation is confined to https goofish.com, by exact parsed host and scheme', () => {
  for (const url of [HOME, BOOT_URL, 'https://www.goofish.com/search?q=x220', 'https://goofish.com/item?id=1']) {
    assert.equal(ensureGoofishUrl(url), url);
  }
  for (const url of [
    'file://www.goofish.com/item?id=1',                       // right host, wrong scheme
    'https://www.goofish.com@evil.com/',                    // userinfo trick
    'http://www.goofish.com/',                              // not https
    'https://evil.com/?id=1',
    'https://www.goofish.com.evil.com/',
    'https://sub.www.goofish.com/',
    'http://',                                              // unparseable
    'not a url',
  ]) {
    assert.throws(() => ensureGoofishUrl(url), (e: any) => e instanceof NavigationError, url);
  }
});

test('the two refusals are GatedErrors, and each class name is the published error_type', () => {
  assert.ok(new SearchUnavailableError('') instanceof GatedError);
  assert.ok(new DetailUnavailableError('') instanceof GatedError);
  assert.ok(new GatedError('') instanceof XianyuError);
  // no minified or anonymous class names leak into error_type
  assert.deepEqual([BrowserError, GatedError, SearchUnavailableError, DetailUnavailableError, ParseError, NavigationError].map((c) => c.name),
    ['BrowserError', 'GatedError', 'SearchUnavailableError', 'DetailUnavailableError', 'ParseError', 'NavigationError']);
  // the published list is every class this server can raise, plus `Error` for everything else -- and
  // it is the *whole* list, so the README's error_type sentence is exhaustive rather than a sample
  assert.deepEqual(PUBLISHED_ERROR_TYPES, [...[BrowserError, GatedError, SearchUnavailableError, DetailUnavailableError, ParseError, NavigationError, XianyuError].map((c) => c.name), 'Error']);
  assert.equal(describe(new XianyuError('x')).error_type, 'XianyuError');
  // describe runs on the failure path, so a throw whose own message/toString/constructor throws must
  // still produce an envelope: it used to rethrow a TypeError from inside the error reporter
  for (const evil of [Object.create(null), { toString() { throw new Error('no'); } }, { get message(): string { throw new Error('no'); } }, { get constructor(): any { throw new Error('no'); } }]) {
    const d = describe(evil);
    assert.equal(d.error_type, 'Error', `error_type escaped the taxonomy for ${Object.prototype.toString.call(evil)}`);
    assert.equal(typeof d.message, 'string');
  }
  // and a non-Error throw is `Error`, not `String`/`Number`/`Object`/`Symbol`
  for (const thrown of ['boom', 42, { a: 1 }, Symbol('x'), ['a']]) assert.equal(describe(thrown).error_type, 'Error', `error_type for a ${typeof thrown} throw`);
});

test('item_view reads the page the way an anonymous visitor does, and item ids are normalised', () => {
  const tools = read(join(ROOT, 'src', 'tools.ts'));
  const view = tools.match(/const itemView = async[\s\S]*?\n};/)?.[0] ?? '';
  // The read itself lives in `readListing`, shared with search_items' `detail` argument, so that is
  // where the assertions about it belong -- and item_view must still be the thing that calls it.
  assert.ok(view.includes('readListing'), 'item_view delegates the read it publishes');
  const reader = tools.match(/const readListing = async[\s\S]*?\n};/)?.[0] ?? '';
  // The detail call is the page's own, read off the wire. It is never re-issued through the mtop
  // client: measured, the same API with the same payload answers TIMEOUT::接口超时 that way, because
  // goofish attaches a per-call anti-bot blob to requests its own bundle originates. So the answer
  // has to come off the page, and the page has to be loaded for it.
  assert.ok(reader.includes('DETAIL_API'), 'item_view reads the page\'s own detail reply');
  assert.ok(!/call\(\[\['detail'/.test(view), 'it must not re-issue the detail call through the mtop client');
  assert.ok(reader.includes('ITEM_SCRAPE_JS'), 'the DOM stays the fallback, not the only source');
  assert.ok(reader.includes('detail_rendered'), 'and an unrendered page is a typed refusal, not empty data');
  // Both routes check the listing is the one that was asked for, and both before the answer is
  // published: `detailListing` refuses a payload for another id, and the DOM route reads page_item_id.
  const extract = read(join(ROOT, 'src', 'extract.ts'));
  assert.match(extract.match(/export const detailListing[\s\S]*?\n};/)?.[0] ?? '', /wanted && id !== String\(wanted\)/);
  assert.ok(reader.includes('page_item_id'), 'a page serving a different listing is refused');
  // the rail markers reach both scrapers as an argument, so the pattern is built from the list
  // The built form re-quotes string literals, so match either quote style -- what is being asserted
  // is that the pattern is built from the list it is handed, not which quote survived the build.
  assert.match(ITEM_SCRAPE_JS.toString(), /new RegExp\(spec\.rails\.join\((?:'|")\|(?:'|")\)\)/, 'the item scraper must cut the page at the rail markers it is handed');
  assert.deepEqual(RAIL_MARKERS, ['为你推荐', '猜你喜欢', '猜你想看']);
});

test('the read path never clicks the page: the login dialog is left alone, on every path', () => {
  // Measured, headed, same URL, one fresh context per arm: with no dismissal the result cards are in
  // the DOM by t+12s (30 anchors, 5KB of text) *underneath* the ant-modal-mask and the passport login
  // iframe; clicking the close controls (4 of them) put the page into a state where the result list
  // never rendered at all and the 猜你喜欢 rail was served instead, at t+18s and t+24s. So the premise
  // this whole file used to encode -- "it must be closed or the page renders zero cards" -- was
  // backwards, and every retry built on it was retrying a self-inflicted failure.
  // Re-measured later the same day, when goofish was declining every load: the two arms came out the
  // same (20 cards, 2306 vs 2308 bytes, 猜你喜欢, "nothing found", zero query hits) and the only
  // difference was which pixels the mask covered. So the click has never been measured to buy
  // anything, and it is the only thing here with a measured downside.
  //
  // Both scrapers read `querySelectorAll` and `innerText`, which see straight through an overlay, so
  // no path needs the dialog closed. The guard is structural rather than behavioural on purpose: it
  // is the one change that must not be able to come back quietly, and no live page load can be part
  // of a unit test.
  // There is exactly one click in this server, and it is the search results pager. It is not a
  // dialog dismissal: it is the page's own pagination control, and it is the only way past 30 results,
  // because the search API cannot be re-issued (replaying the page's own payload answers TIMEOUT).
  // Measured 5-9.5s per page against 13-25s for a fresh load, 30 new items each, zero overlap.
  //
  // So the blanket "no click anywhere" ban becomes what it was always protecting: no click on the
  // login dialog, and no pointer simulation anywhere. Both still hold absolutely.
  const clicks = (src: string) => src.split('\n').map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => /[^\w.]click\s*\(/.test(l) && !isJustNamingIt(l));
  const pagerJs = read(join(ROOT, 'src', 'extract.ts')).match(/export const PAGER_CLICK_JS[\s\S]*?\n};/)?.[0] ?? '';
  for (const p of sources) {
    // every click, in the whole tree, has to be inside PAGER_CLICK_JS or be a call to it
    for (const [line, text] of clicks(read(p))) {
      assert.ok(pagerJs.includes(text.trim()) || /PAGER_CLICK_JS/.test(text), `${p}:${line} clicks something that is not the search pager: ${text.trim()}`);
    }
  }
  // and it must be a DOM click, not a Playwright pointer click: the anonymous login dialog's
  // ant-modal-mask is exactly what makes Playwright's actionability check time out, so a pointer click
  // on the pager is the one implementation that would not work.
  assert.ok(pagerJs.includes('.click()'), 'the pager click is a DOM click');
  assert.equal(/\.locator\(|\.click\(\{|force:\s*true/.test(read(join(ROOT, 'src', 'tools.ts'))), false,
    'no Playwright pointer click: the login dialog\'s mask would eat it');
  // nothing in the page-machinery modules is allowed to click at all
  for (const p of sources.filter((f) => !f.includes('extract.ts'))) assert.deepEqual(clicks(read(p)), [], `${p} clicks something`);
  // the selectors the dismisser used are gone with it, not left behind as dead machinery
  const extract = read(join(ROOT, 'src', 'extract.ts')), browser = read(join(ROOT, 'src', 'browser.ts'));
  for (const gone of ['DISMISS_LOGIN_JS', 'dismissLogin', 'baxia-dialog', 'closeIcon', 'modal-close', 'dialog-close']) {
    assert.equal(extract.includes(gone) || browser.includes(gone), false, `${gone} is back`);
  }
  // and the two entry points that used to call it -- Session.open, which every scraper goes through,
  // and search_items' own poll loop -- are the two that would reintroduce it
  const open = browser.match(/async open\([\s\S]*?\n  }/)?.[0] ?? '';
  const toolsSrc = read(join(ROOT, 'src', 'tools.ts'));
  const search = toolsSrc.match(/const searchItems = async[\s\S]*?\n};/)?.[0] ?? '';
  assert.ok(search.includes('SCRAPE_CARDS_JS'));
  // The wait is immediately followed by the read, with the over-ask rationale in between. The delay
  // itself is deliberately not pinned: what matters is the order and the reason, and a test that
  // asserted "700" broke the moment the poll interval was retuned with nothing getting worse.
  assert.match(search, /await settle\(page, \d+\);\s*\n\s*\/\/ Over-ask[^]*?scrape\(page, SCRAPE_CARDS_JS/, 'the poll loop must go straight from waiting to reading');
  assert.equal(/\bdismiss[A-Za-z]*\(/.test(open + search), false);
  // the measurement is written down where the next reader of this function will actually see it: on
  // the doc comment above it, not only in this test file
  const why = toolsSrc.slice(0, toolsSrc.indexOf('const searchItems')).split('/**').pop() ?? '';
  assert.match(why, /closes? its close controls was measured|never rendered|left alone/i, 'say why the dialog is left alone');
});

test('a second shutdown does not exit while the teardown is still running', () => {
  // Closing stdin emits BOTH `end` and `close`, and Ctrl-C is SIGINT then SIGTERM. The re-entrancy
  // guard used to call `process.exit` on the second one, which killed the process mid-`browser.close()`
  // and left the windowed Chromium running, reparented to init: measured, 15 orphaned processes after
  // one audit run. The guard has to let the in-flight teardown finish -- `Session.close` is bounded at
  // 5s and escalates to SIGKILL, so it is not the thing that can hang.
  const idx = read(join(ROOT, 'src', 'index.ts'));
  const shutdown = idx.match(/const shutdown = [\s\S]*?\n};/)?.[0] ?? '';
  assert.match(shutdown, /if \(closing\) return;/, 'the re-entrant path returns instead of exiting');
  assert.equal(/if \(closing\)[^;]*process\.exit/.test(shutdown), false, 'it must not exit on the way in');
  // and there is exactly one exit, after the teardown
  assert.equal((shutdown.match(/process\.exit/g) ?? []).length, 1, 'one exit, and it is after the close');
  assert.ok(shutdown.indexOf('getSession().close()') < shutdown.indexOf('process.exit'), 'close first, then exit');
  // every way out funnels through it, and the crash path does something synchronous and real
  for (const route of ['transport.onclose = () => shutdown(0)', "process.stdin.on('end', () => shutdown(0))", "process.stdin.on('close', () => shutdown(0))", "process.on(signal, () => shutdown(0))"]) {
    assert.ok(idx.includes(route), `${route} is gone, so a client could walk away and take the browser with it`);
  }
  assert.match(idx.match(/process\.on\('exit'[\s\S]*?\}\);/)?.[0] ?? '', /killBrowser\(\)/, 'the exit hook must kill synchronously -- it cannot await');
});

test('the browser launches windowed by default, because headless is served the risk-control page', () => {
  const src = read(join(ROOT, 'src', 'browser.ts'));
  // Measured: headed serves the app (20 cards, 2.3KB, the real filter bar); headless serves the same
  // URL as "非法访问" for 128s straight -- zero cards, 35 bytes -- so the three DOM tools need a display.
  assert.match(src, /headless: process\.env\.XIANYU_HEADLESS !== '1'/);
  assert.match(src, /risk-control/, 'the reason for the default has to be written down next to it');
  assert.match(src, /mtop tools work either way|does not:\s*\n?\s*\*?\s*the page's own client boots on the risk-control page/);
});

test('a build says which commit it is, and the check that compares it is not a second copy', () => {
  // The failure this guards against is not a crash but a silence. opencode.json pointed this server at
  // a dist/ built from a checkout thirteen commits behind main; every tool answered plausibly, the MCP
  // handshake advertised 0.2.0 from package.json so the version looked right, and nothing anywhere
  // said the code was old. A build that cannot name its own commit cannot be shown to be current, and
  // the version in the handshake demonstrably was not enough to notice.
  const info = read(join(ROOT, 'src', 'build-info.ts'));
  const cli = readFileSync(join(ROOT, 'scripts', 'check-deploy.mjs'), 'utf8');

  // The stamp exists, is written by the build, and carries the commit.
  assert.match(JSON.parse(read(join(ROOT, 'package.json'))).scripts.build, /scripts\/stamp-build\.mjs/, 'npm run build must stamp what it built');
  assert.match(read(join(ROOT, 'scripts', 'stamp-build.mjs')), /build-info\.json/);
  assert.match(info, /dist'?,?\s*'build-info\.json'|build-info\.json/, 'build-info.ts must read the stamp');
  assert.match(info, /rev-parse/, 'a build with no stamp still names itself from the checkout');

  // The stamp travels with the build rather than being read off the tree at serve time. That is the
  // property that makes it worth having: the checkout moves, the bytes do not, and a tree-relative
  // answer would change without the served code changing.
  assert.match(info, /subject/, 'the comparison must be against the build\'s own commit, not HEAD');
  assert.match(info, /this checkout has moved since the build/, 'and it must say when the two disagree');

  // "Could not measure" is never "current". Reporting null as false is how the original drift stayed
  // invisible: the one thing that could have spoken did not, because its fallback was reassurance.
  assert.match(info, /stale: behind === null \? null/, 'an unmeasured staleness must stay null');
  assert.match(info, /unverified rather than current/);

  // The comparison has to fetch, or it counts against a cache. Measured on the real deployment: the
  // same directory reported OK with the cached ref and 13 commits behind after a fetch, because the
  // stale clone's own origin/main pointed at its stale commit. A check that reads the cached ref is a
  // check that cannot see this failure.
  assert.match(cli, /'fetch'/, 'the check must fetch before counting');
  assert.match(cli, /--no-fetch/, 'and offer an explicit airgapped path');
  assert.match(cli, /only as fresh as that/, 'which must admit its verdict is cached');

  // One set of rules, two callers. A drift check with its own arithmetic would eventually disagree
  // with the block `capabilities` publishes to every agent about what "stale" means.
  assert.match(cli, /import \{ buildInfo, deployVerdict \} from '\.\.\/src\/build-info\.ts'/);
  assert.equal(/rev-list/.test(cli), false, 'the CLI must not do its own commit arithmetic');

  // An unstamped build must fail rather than pass quietly, since that is the state the drifted
  // deployment was in and the check has no other way to notice it.
  assert.match(info, /unstamped|records no commit|no build-info\.json/);

  // CI asserts the stamp matches HEAD, so a build cannot ship carrying someone else's commit.
  assert.match(read(join(ROOT, '.github', 'workflows', 'ci.yml')), /build-info\.json/);

  // And the server publishes it, because the check only helps someone who runs it. `capabilities` is
  // the call every agent is told to make first, so it is the one place a stale deploy announces itself
  // without anyone asking.
  const toolsSrc = read(join(ROOT, 'src', 'tools.ts'));
  assert.match(toolsSrc, /build: \{/, 'capabilities must carry a build block');
  assert.match(toolsSrc, /\.\.\.buildBlock\(\)/, 'built from buildInfo rather than assembled inline');
});
