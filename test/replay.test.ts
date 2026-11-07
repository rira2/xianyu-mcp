/**
 * The replay fast path's pure half, and the session method that drives it.
 *
 * The recipe is small and every part of it is a value somebody measured: the payload the page itself
 * sends, the md5 signature over `token&t&appKey&data`, the URL with the page's own parameter set, and
 * the two shapes a reply has to have before a tool may answer from it. Those are tested here against
 * constants computed independently (node:crypto) rather than against the implementation's own output.
 *
 * `Session.replay` is then driven against a fake page and a fake cookie jar, because the browser is
 * not the thing under test: the token read, the signing, the parse and the one-reload retry are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Session, setSession } from '../src/browser.ts';
import { MTOP_READY_JS, REPLAY_READY_JS } from '../src/extract.ts';
import { withDeadline } from '../src/runtime.ts';
import {
  APP_KEY, DETAIL_API, SEARCH_API, detailPayload, replayEnabled, replaySign, replayUrl,
  searchPayload, validateReplayReply,
} from '../src/replay.ts';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

test('the search payload is exactly the 13 keys the page sends, with the page number asked for', () => {
  const payload = searchPayload('thinkpad x220', 2);
  assert.deepEqual(Object.keys(payload), ['pageNumber', 'keyword', 'fromFilter', 'rowsPerPage', 'sortValue', 'sortField', 'customDistance', 'gps', 'propValueStr', 'customGps', 'searchReqFromPage', 'extraFilterValue', 'userPositionJson']);
  assert.deepEqual(payload, {
    pageNumber: 2, keyword: 'thinkpad x220', fromFilter: false, rowsPerPage: 30, sortValue: '', sortField: '',
    customDistance: '', gps: '', propValueStr: {}, customGps: '', searchReqFromPage: 'pcSearch',
    extraFilterValue: '{}', userPositionJson: '{}',
  });
  // Fresh objects: signing stringifies the payload, and two builders sharing one nested object would
  // make a later mutation change an earlier signature's input.
  assert.notEqual(searchPayload('x', 1), searchPayload('x', 1));
  assert.notEqual(searchPayload('x', 1).propValueStr, searchPayload('x', 2).propValueStr);
});

test('the detail payload is the one-key object the page sends', () => {
  assert.deepEqual(detailPayload('123'), { itemId: '123' });
});

test('the signature is md5 of token&t&appKey&data, computed independently here', () => {
  assert.equal(replaySign('abc', 1000, '{"a":1}'), md5('abc&1000&34839810&{"a":1}'));
  // The same values the spike verified against the page's own outgoing requests.
  assert.equal(replaySign('9bd6acf6f30a2633489e52315e60ccd9', 1793995896771, JSON.stringify(searchPayload('thinkpad x220', 1))), md5(`9bd6acf6f30a2633489e52315e60ccd9&1793995896771&34839810&${JSON.stringify(searchPayload('thinkpad x220', 1))}`));
  assert.equal(replaySign('abc', 1000, '{}', '12574478'), md5('abc&1000&12574478&{}'), 'the appKey is a parameter, not a constant');
});

test('the replay URL carries the page\'s own parameter set, and only the spm parameters it was given', () => {
  const url = replayUrl(SEARCH_API, { t: 1793995896771, sign: 'deadbeef', spmCnt: 'a21ybx.search.0.0', spmPre: 'a21ybx.home.searchInput.0' });
  for (const part of ['https://h5api.m.goofish.com/h5/', `/1.0/?jsv=2.7.2`, 'appKey=34839810', 'v=1.0', 'type=originaljson', 'accountSite=xianyu', 'dataType=json', 'timeout=20000', `api=${encodeURIComponent(SEARCH_API)}`, 'sessionOption=AutoLoginOnly', 'spm_cnt=a21ybx.search.0.0', 'spm_pre=a21ybx.home.searchInput.0', 't=1793995896771', 'sign=deadbeef']) {
    assert.ok(url.includes(part), `${part} missing from ${url}`);
  }
  assert.ok(url.includes(`/h5/${encodeURIComponent(SEARCH_API)}/1.0/`), 'the API is the path segment, so it must be in the URL twice');
  // The detail call carries spm_cnt and no spm_pre; an empty spm_pre must not be sent as `spm_pre=`.
  const detail = replayUrl(DETAIL_API, { t: 1, sign: 's', spmCnt: 'a21ybx.item.0.0' });
  assert.ok(detail.includes('spm_cnt=a21ybx.item.0.0'));
  assert.equal(detail.includes('spm_pre'), false);
});

test('a reply is usable only if SUCCESS and the shape the caller reads is there', () => {
  const searchOk = validateReplayReply({ ret: ['SUCCESS::调用成功'], data: { resultList: [] } }, 'search');
  assert.equal(searchOk.ok, true, 'an empty resultList is a valid search answer, not a failure');
  assert.equal(searchOk.ret, 'SUCCESS::调用成功');
  assert.deepEqual(searchOk.data, { resultList: [] });

  const gated = validateReplayReply({ ret: ['RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!'], data: { url: 'https://h5api.m.goofish.com/...' } }, 'search');
  assert.equal(gated.ok, false);
  assert.match(gated.why, /RGV587/, 'the refusal travels out so the caller can name it');
  assert.match(gated.ret, /^RGV587_ERROR/);

  assert.equal(validateReplayReply({ ret: ['SUCCESS::调用成功'], data: null }, 'search').ok, false, 'SUCCESS with no data is a shape change');
  assert.equal(validateReplayReply({ ret: 'SUCCESS::调用成功', data: { resultList: {} } }, 'search').ok, false, 'resultList must be an array');
  assert.equal(validateReplayReply({}, 'search').ok, false, 'a body with no ret at all is not an answer');

  const detailOk = validateReplayReply({ ret: ['SUCCESS::调用成功'], data: { itemDO: { itemId: '123' } } }, 'detail');
  assert.equal(detailOk.ok, true);
  assert.deepEqual(detailOk.data.itemDO, { itemId: '123' });
  assert.equal(validateReplayReply({ ret: ['SUCCESS::调用成功'], data: { itemDO: null } }, 'detail').ok, false, 'detail needs itemDO');
  assert.equal(validateReplayReply({ ret: ['SUCCESS::调用成功'], data: { resultList: [] } }, 'detail').ok, false, 'a search shape is not a detail answer');
});

test('the kill switch is XIANYU_REPLAY=0 and nothing else', () => {
  const previous = process.env.XIANYU_REPLAY;
  try {
    delete process.env.XIANYU_REPLAY;
    assert.equal(replayEnabled(), true, 'the fast path is on by default');
    process.env.XIANYU_REPLAY = '0';
    assert.equal(replayEnabled(), false);
    for (const value of ['1', 'true', 'no', 'off', '']) { process.env.XIANYU_REPLAY = value; assert.equal(replayEnabled(), true, `XIANYU_REPLAY=${JSON.stringify(value)} leaves the fast path on`); }
  } finally {
    if (previous === undefined) delete process.env.XIANYU_REPLAY; else process.env.XIANYU_REPLAY = previous;
  }
});

// ------------------------------------------------------------------ Session.replay, against fakes

/** A page whose in-page fetch answers whatever the test queues, plus a record of what it was asked.
 *  `replies` is consumed in order; the last one repeats, so a retry sees a second answer. The
 *  readiness probes answer "ready", the way a hydrated homepage does. */
const replayPage = (replies: { status?: number; text: string }[]) => {
  const calls: any[] = [];
  let at = 'https://www.goofish.com/';
  const page: any = {
    url: () => at,
    isClosed: () => false,
    on: () => {},
    goto: async (u: string) => { at = u; },
    reload: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn: any, arg: any) => {
      if (fn === MTOP_READY_JS) return 'ready';
      if (fn === REPLAY_READY_JS) return { ready: true, mtop: true, search_inputs: 1, path: '/' };
      if (arg?.url) { calls.push(arg); return replies.length > 1 ? replies.shift()! : replies[0]; }
      return null;
    },
    calls,
  };
  return page;
};
/** A cookie jar as Playwright returns one. The token is `<32 hex>_<server epoch ms>`, and only the
 *  first half is signed. `tokens` is read in order so a retry can see a rotated one. */
const jar = (token: string) => [{ name: '_m_h5_tk', value: `${token}_1793999999999`, domain: '.goofish.com', path: '/' }, { name: '_m_h5_tk_enc', value: 'enc' }];

const sessionReplaying = (replies: { status?: number; text: string }[], opts: { token?: string; tokens?: string[] } = {}) => {
  const s = new Session();
  const page = replayPage(replies);
  const tokens = opts.tokens ?? [opts.token ?? 'a'.repeat(32)];
  let reads = 0;
  (s as any).context = { cookies: async () => jar(tokens[Math.min(reads++, tokens.length - 1)]), newPage: async () => page };
  (s as any).apiPage = page;
  (s as any).domPage = page;
  (s as any).replayPage = page;
  setSession(s);
  return { s, page };
};

test('Session.replay signs with the jar token and answers with the parsed data', async () => {
  const body = JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { resultList: [{ id: 1 }, { id: 2 }] } });
  const { s, page } = sessionReplaying([{ status: 200, text: body }], { token: 'f'.repeat(32) });
  const verdict = await s.replay(SEARCH_API, searchPayload('x', 1), { spmCnt: 'a21ybx.search.0.0', spmPre: 'a21ybx.home.searchInput.0' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ret, 'SUCCESS::调用成功');
  assert.deepEqual(verdict.data, { resultList: [{ id: 1 }, { id: 2 }] });
  assert.ok(verdict.ms >= 0);
  assert.equal(page.calls.length, 1);
  const sent = page.calls[0];
  const url = new URL(sent.url);
  assert.equal(url.searchParams.get('api'), SEARCH_API);
  assert.equal(url.searchParams.get('appKey'), APP_KEY);
  assert.equal(url.searchParams.get('spm_cnt'), 'a21ybx.search.0.0');
  assert.equal(url.searchParams.get('spm_pre'), 'a21ybx.home.searchInput.0');
  // the body is a form field named `data`, exactly as the page's own interceptor expects
  assert.equal(sent.body, `data=${encodeURIComponent(JSON.stringify(searchPayload('x', 1)))}`);
  // and the signature in the URL is the one this token/t/sign/data produce
  const data = searchPayload('x', 1);
  assert.equal(url.searchParams.get('sign'), replaySign('f'.repeat(32), Number(url.searchParams.get('t')), JSON.stringify(data), APP_KEY));
});

test('Session.replay never throws: a refusal, an unparseable body, a missing token and a lying page all come back as a verdict', async () => {
  const refusal = sessionReplaying([{ status: 200, text: JSON.stringify({ ret: ['RGV587_ERROR::SM::被挤爆啦'] }) }]);
  const gated = await refusal.s.replay(SEARCH_API, searchPayload('x', 1));
  assert.equal(gated.ok, false);
  assert.match(gated.ret, /RGV587/);
  assert.match(String(gated.why), /RGV587/);

  const garbage = sessionReplaying([{ status: 200, text: '<html>not json</html>' }]);
  const unparseable = await garbage.s.replay(SEARCH_API, searchPayload('x', 1));
  assert.equal(unparseable.ok, false);
  assert.match(String(unparseable.why), /not JSON|unparseable|parse/i);

  // The detail surface is the item page, which is already hydrated, so the missing-token path costs
  // one reload rather than the homepage's cold-start window: exactly the case `rehydrate` bounds.
  const noToken = sessionReplaying([{ status: 200, text: JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { itemDO: { itemId: '1' } } }) }]);
  (noToken.s as any).context = { cookies: async () => [], newPage: async () => noToken.page };
  const missing = await noToken.s.replay(DETAIL_API, detailPayload('1'));
  assert.equal(missing.ok, false);
  assert.match(String(missing.why), /token/i);
  assert.equal(noToken.page.calls.length, 0, 'no request is sent without a token to sign it');

  // An evaluate that rejects is a failed attempt, not an exception out of the tool.
  const dead = sessionReplaying([{ status: 200, text: '{}' }]);
  dead.page.evaluate = async () => { throw new Error('Target page, context or browser has been closed'); };
  const closed = await dead.s.replay(SEARCH_API, searchPayload('x', 1));
  assert.equal(closed.ok, false);
  assert.ok(closed.why);
});

test('Session.replay waits for a token that is still being minted instead of reloading the page', async () => {
  // The item page's token appears a moment after it loads -- measured: the replay on a just-loaded
  // item page found no `_m_h5_tk`, and the fix for that is a short wait, not a reload that re-pays the
  // whole page load. The jar here answers empty first and a token on the second read.
  const fresh = JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { itemDO: { itemId: '42' } } });
  const s = new Session();
  const page = replayPage([{ status: 200, text: fresh }]);
  let reads = 0, gotos = 0;
  const goto = page.goto;
  page.goto = async (u: string) => { gotos++; return goto(u); };
  (s as any).context = { cookies: async () => (reads++ ? jar('c'.repeat(32)) : []), newPage: async () => page };
  (s as any).apiPage = page;
  (s as any).domPage = page;
  setSession(s);
  const verdict = await s.replay(DETAIL_API, detailPayload('42'), { spmCnt: 'a21ybx.item.0.0' });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(gotos, 0, 'the page was not reloaded to mint a token that was already on its way');
  assert.ok(reads >= 2, 'the jar was polled');
});

test('Session.replay reloads once and retries when goofish says the token is stale', async () => {
  const stale = JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EXPIRED::令牌过期'] });
  const fresh = JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { itemDO: { itemId: '42' } } });
  const { s, page } = sessionReplaying([{ status: 200, text: stale }, { status: 200, text: fresh }], { token: 'b'.repeat(32) });
  let gotos = 0;
  const goto = page.goto;
  page.goto = async (u: string) => { gotos++; return goto(u); };
  const verdict = await s.replay(DETAIL_API, detailPayload('42'), { spmCnt: 'a21ybx.item.0.0' });
  assert.equal(verdict.ok, true, `the retry after a token failure is what makes a rotated token survivable: ${JSON.stringify(verdict)}`);
  assert.deepEqual(verdict.data, { itemDO: { itemId: '42' } });
  assert.equal(page.calls.length, 2, 'one attempt per token state, no loop');
  assert.equal(gotos, 1, 'a token-shaped ret buys exactly one cache-busted reload');
});

test('a failed replay pauses that route instead of paying the same failure on the next call', async () => {
  const { s, page } = sessionReplaying([{ status: 200, text: JSON.stringify({ ret: ['RGV587_ERROR::SM::被挤爆啦'] }) }]);
  const first = await s.replay(SEARCH_API, searchPayload('x', 1));
  assert.equal(first.ok, false);
  assert.equal(page.calls.length, 1);
  const second = await s.replay(SEARCH_API, searchPayload('x', 2));
  assert.equal(second.ok, false);
  assert.match(String(second.why), /paused/i, 'the second call is told why it did not try');
  assert.equal(page.calls.length, 1, 'and it does not send a second request in the pause window');
  // The other surface is untouched: a search failure says nothing about the detail API.
  const other = await s.replay(DETAIL_API, detailPayload('1'));
  assert.notEqual(other.why, undefined);
  assert.equal(page.calls.length, 2, 'detail still gets its own attempt');
});

test('concurrent replays are issued one at a time on the page that signs them', async () => {
  // The spike never measured concurrent in-page fetches against goofish's per-IP limit, so the safe
  // default is one at a time. This is what keeps a `detail: 4` fan-out's serial fallback from firing
  // four signed requests at once.
  const s = new Session();
  const page = replayPage([{ status: 200, text: JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { resultList: [] } }) }]);
  let released!: () => void;
  const gate = new Promise<void>((r) => { released = r; });
  const real = page.evaluate;
  page.evaluate = async (fn: any, arg: any) => { if (arg?.url) { page.calls.push(arg); await gate; return { status: 200, text: JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { resultList: [] } }) }; } return real(fn, arg); };
  (s as any).context = { cookies: async () => jar('d'.repeat(32)), newPage: async () => page };
  (s as any).apiPage = page;
  (s as any).domPage = page;
  (s as any).replayPage = page;
  setSession(s);
  const one = s.replay(SEARCH_API, searchPayload('x', 1));
  const two = s.replay(SEARCH_API, searchPayload('x', 2));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(page.calls.length, 1, 'the second call waits for the first to finish');
  released();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(page.calls.length, 2);
  assert.deepEqual(page.calls.map((c: any) => new URL(c.url).searchParams.get('t') !== null), [true, true]);
});

test('Session.replay will not start on a budget that cannot also pay the typed route', async () => {
  // The gate has to be about the call's clock, not about whether it has one: a 20s attempt begun with
  // a second left is how a search that used to answer came back "Call deadline reached".
  const { s, page } = sessionReplaying([{ status: 200, text: JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { resultList: [] } }) }]);
  await withDeadline(1, async () => {
    const search = await s.replay(SEARCH_API, searchPayload('x', 1));
    assert.equal(search.ok, false);
    // A search's gate is the typed route's 15s reserve plus a second of fetch (the fetch itself is
    // capped to `left - reserve`), so the message names the reserve it could not leave.
    assert.match(String(search.why), /reserve for the typed route/i, 'the entry gate names the reserve it could not leave');
    assert.match(String(search.why), /second of fetch/i);
    const detail = await s.replay(DETAIL_API, detailPayload('1'));
    assert.equal(detail.ok, false);
    assert.match(String(detail.why), /attempt \+ \d+s reserve/i, 'a detail replay still has to pay for its page preparation');
  });
  assert.equal(page.calls.length, 0, 'no fetch was issued when the call could not afford it');
});

test('a stale token does not buy a reload the call cannot afford', async () => {
  // 40s passes the search entry gate (35s) but is short of the 45s a reload-and-retry would need.
  const stale = JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EXPIRED::令牌过期'] });
  const { s, page } = sessionReplaying([{ status: 200, text: stale }]);
  await withDeadline(40, async () => {
    const verdict = await s.replay(SEARCH_API, searchPayload('x', 1));
    assert.equal(verdict.ok, false);
    assert.match(verdict.ret, /FAIL_SYS_TOKEN_EXPIRED/, 'the token failure is reported, not swallowed');
    assert.match(String(verdict.why), /reload-and-retry/i);
  });
  assert.equal(page.calls.length, 1, 'one fetch, no reload paid out of the typed route\'s reserve');
});

test('XIANYU_REPLAY=0 makes Session.replay a no-op that never touches the browser', async () => {
  const previous = process.env.XIANYU_REPLAY;
  try {
    process.env.XIANYU_REPLAY = '0';
    const { s, page } = sessionReplaying([{ status: 200, text: JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { resultList: [] } }) }]);
    const verdict = await s.replay(SEARCH_API, searchPayload('x', 1));
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.why), /XIANYU_REPLAY/);
    assert.equal(page.calls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.XIANYU_REPLAY; else process.env.XIANYU_REPLAY = previous;
  }
});

test.afterEach(() => { setSession(null); delete process.env.XIANYU_REPLAY; });
