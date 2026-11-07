import { createHash } from 'node:crypto';

/**
 * The signed-replay recipe, as pure functions.
 *
 * goofish's search and item-detail APIs can be called directly, without typing into the SPA, if the
 * call is issued as a `fetch` from the goofish page itself with a fresh md5 signature: the page's own
 * interceptor attaches the `bx-ua` / `bx-umidtoken` / `bx_et` anti-bot fields to any form POST that
 * carries `data`, and the gateway accepts it. Measured on this machine, 2026-11-07: 1.06s for a
 * 30-result search page, 3.12s for an item detail, against 7.5s for one typed search. The full recipe
 * and the failures that pin it are in `/tmp/xianyu-spike/FINDINGS.md` and in `README.md`.
 *
 * Nothing here touches a browser: the token and the page live in `browser.ts`, and this module is only
 * the values and the checks, so the payload, the signature and the reply contract can be tested
 * against constants instead of against a live site.
 *
 * The payloads are the page's own. The search one is the exact 13-key object the SPA sent on
 * 2026-11-06; `pageNumber` is the only key that changes for pagination. The detail one is `{itemId}`.
 */

/** The appKey the search and detail APIs are signed with. Not `window.lib.mtop`'s 12574478: that
 *  client's requests for these APIs answer `TIMEOUT::接口超时`, which is why this module exists. */
export const APP_KEY = '34839810';
export const SEARCH_API = 'mtop.taobao.idlemtopsearch.pc.search';
export const DETAIL_API = 'mtop.taobao.idle.pc.detail';
/** Where the page's interceptor and the signature token come from. */
export const H5API_ORIGIN = 'https://h5api.m.goofish.com';

/** The one switch that turns the fast path off, read per call like every other knob: `XIANYU_REPLAY=0`
 *  falls back to the typed search and the item page load. */
export const replayEnabled = (): boolean => process.env.XIANYU_REPLAY !== '0';

/**
 * How long one attempt may run before the fast path gives up: measured answers were 1.0-1.2s for a
 * search page and 0.6-3.1s for a detail, and a hung in-page fetch never settles at all, so this bound
 * is what turns a hang into a fallback. In milliseconds because the budget gate below adds to it.
 */
export const REPLAY_ATTEMPT_MS = { search: 20_000, detail: 12_000 } as const;
/** What a replay must leave on the call's clock for the route behind it. The typed search costs a page
 *  load plus a keystroke (measured 15-60s) and an item page 4-10s; this is the floor that keeps a
 *  failed fast path from turning an answer into "Call deadline reached". */
export const REPLAY_RESERVE_MS = 15_000;
/** A full attempt plus the reserve the typed route needs: 35s for a search, 27s for a detail. It is
 *  the bound `Session.replay` applies to its own retry-and-reload decisions, and the start gate for a
 *  detail replay -- preparing an item page is a separate surface that may reload, and `item_view`'s
 *  default budget (90s) can afford the full attempt. */
export const replayMinBudgetMs = (kind: 'search' | 'detail'): number => REPLAY_ATTEMPT_MS[kind] + REPLAY_RESERVE_MS;
/** One second of fetch is the smallest attempt worth starting; below it there is nothing to sign. */
export const REPLAY_MIN_FETCH_MS = 1_000;
/**
 * The budget a **search** replay may start on: the typed route's reserve plus that one second.
 *
 * The old gate was a full attempt plus the reserve (35s), and a batch's per-query budget is now 30s --
 * so a default scan would never have taken the signed replay at all and every row would have paid the
 * typed route's 15-45s. The reserve is not dropped by lowering the entry gate: inside the attempt the
 * in-page fetch is still capped to `left - REPLAY_RESERVE_MS`, so the typed route keeps exactly its
 * 15 seconds and a full 20s attempt only happens on a call that can pay for it. A 30s query therefore
 * gets 15s of replay before the reserve begins, which is 5-15x the measured 1-3s answer. Detail keeps
 * the larger `replayMinBudgetMs` gate.
 */
export const replayStartBudgetMs = (kind: 'search' | 'detail'): number =>
  kind === 'detail' ? replayMinBudgetMs(kind) : REPLAY_RESERVE_MS + REPLAY_MIN_FETCH_MS;

/** The page's own search payload. A fresh object every call, including the nested ones: the payload is
 *  stringified to sign it, so a shared nested object would make one call's mutation another's
 *  signature input. */
export const searchPayload = (query: string, pageNumber: number): Record<string, any> => ({
  pageNumber, keyword: query, fromFilter: false, rowsPerPage: 30, sortValue: '', sortField: '',
  customDistance: '', gps: '', propValueStr: {}, customGps: '', searchReqFromPage: 'pcSearch',
  extraFilterValue: '{}', userPositionJson: '{}',
});

/** The page's own detail payload: the id, as a string, and nothing else. */
export const detailPayload = (itemId: string): Record<string, any> => ({ itemId });

/** `md5(token + '&' + t + '&' + appKey + '&' + dataJson)`, hex. Verified byte-for-byte against the
 *  page's own outgoing signature twice in the spike (see FINDINGS.md §1.4). */
export const replaySign = (token: string, t: number, dataJson: string, appKey = APP_KEY): string =>
  createHash('md5').update(`${token}&${t}&${appKey}&${dataJson}`).digest('hex');

/**
 * The URL the page's own request used, with a fresh `t` and `sign`. Every parameter is carried, not
 * just the two the signature needs: a request with a fresh signature but without `accountSite`,
 * `timeout`, `spm_cnt` and `spm_pre` answers `RGV587_ERROR` instead of data. `spm_pre` is omitted when
 * the caller has none, which is the detail call's shape.
 */
export const replayUrl = (api: string, opts: { t: number; sign: string; appKey?: string; spmCnt?: string; spmPre?: string }): string => {
  const appKey = opts.appKey ?? APP_KEY;
  const parts = [
    `jsv=2.7.2`, `appKey=${appKey}`, `v=1.0`, `type=originaljson`, `accountSite=xianyu`, `dataType=json`,
    `timeout=20000`, `api=${api}`, `sessionOption=AutoLoginOnly`,
  ];
  if (opts.spmCnt) parts.push(`spm_cnt=${opts.spmCnt}`);
  if (opts.spmPre) parts.push(`spm_pre=${opts.spmPre}`);
  parts.push(`t=${opts.t}`, `sign=${opts.sign}`);
  return `${H5API_ORIGIN}/h5/${api}/1.0/?${parts.join('&')}`;
};

/**
 * Is this mtop reply an answer a tool may use? `SUCCESS` in `ret` plus the shape that tool reads:
 * `data.resultList` an array for search (an empty array is a real, empty answer), `data.itemDO` an
 * object for detail. Everything else is a named reason to fall back, never an exception: a refusal, a
 * body that is not JSON and a shape change all arrive here as the same kind of verdict.
 */
export const validateReplayReply = (body: any, kind: 'search' | 'detail'): { ok: boolean; ret: string; data: any; why: string } => {
  const raw = body?.ret;
  const ret = Array.isArray(raw) ? raw.join(' | ') : String(raw ?? '');
  const data = body?.data ?? null;
  if (!ret) return { ok: false, ret: '', data, why: 'goofish answered with no ret at all' };
  if (!ret.includes('SUCCESS')) return { ok: false, ret, data, why: `goofish refused the replay: ${ret}` };
  if (kind === 'search') {
    if (!Array.isArray(data?.resultList)) return { ok: false, ret, data, why: 'the replay carried SUCCESS but no resultList array' };
    return { ok: true, ret, data, why: '' };
  }
  if (!data?.itemDO || typeof data.itemDO !== 'object') return { ok: false, ret, data, why: 'the replay carried SUCCESS but no itemDO' };
  return { ok: true, ret, data, why: '' };
};

/** A ret that names the signature token or the session rather than the request: the page can mint a
 *  new one, so it is worth one reload and one retry. Anything else is a refusal this call cannot fix. */
export const replayTokenFailure = (ret: string): boolean => /FAIL_SYS_TOKEN|令牌过期|SESSION_EXPIRED/i.test(ret);
