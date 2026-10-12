/**
 * The in-page scripts. They run in a throwaway Chromium page that has never had
 * an account, so they borrow the page's own mtop client
 * (`window.lib.mtop.request`) instead of minting tokens, signing requests and
 * spoofing a fingerprint here. The site does that work itself, which is why
 * this server drives a browser rather than talking HTTP.
 *
 * Exported as functions rather than strings so the tests can run them against a
 * synthetic document -- node strips the type annotations before Playwright
 * serialises the function. Page globals are read off `globalThis`: there is no
 * DOM lib in a node build, and the boundary is the thing being described.
 *
 * Each function stands alone. Playwright serialises the function and its single
 * argument and nothing else, so a fact two of them share -- the rail markers,
 * `RAIL_MARKERS` -- arrives as an argument, not as a constant one of them
 * closes over.
 */

/**
 * The one list of "recommendation rail, not results" markers. Both scrapers
 * below cut on it and `tools.ts` passes it in, so the two cannot drift. They did
 * once: the item scraper knew 猜你想看, the card scraper did not, and a page headed
 * 猜你想看 came back as search results.
 *
 * Two jobs in one list. It is the card scraper's detection set and the item
 * scraper's truncation point, so a marker added to close a detection gap also
 * moves where the item scrape cuts. Split it if that coupling bites.
 */
export const RAIL_MARKERS = ['为你推荐', '猜你喜欢', '猜你想看'];

/**
 * The one attribute the two search scripts agree on, so the second can find
 * what the first marked. Exported and passed as each script's single argument
 * rather than closed over, for the reason `RAIL_MARKERS` is: a module-level
 * constant read inside the page is a `ReferenceError` at run time that `tsc`
 * cannot see, since to the type the page has the name in scope. It was a live
 * bug -- every search attempt died with `SEARCH_MARK is not defined` and 0/4
 * searches returned anything. A leftover marker is harmless: the finder
 * overwrites it.
 */
export const SEARCH_MARK = 'data-xianyu-search';

/**
 * Split a query into the terms a listing title has to contain, in any order.
 *
 * goofish titles are in whatever word order the seller typed, and Chinese has
 * no spaces to learn word boundaries from, so an exact-substring test rejects
 * almost everything on this site. A search for `机械硬盘4t` -- 70,146 listings by
 * goofish's own counter -- returned nothing at all, because the titles say
 * `西数4T机械硬盘`. Cutting at the CJK/Latin boundary as well as at whitespace
 * turns that one query into `机械硬盘` + `4t`. The recommendation rail still
 * fails it, which is correct: a rail full of bicycles cannot contain both.
 *
 * Deliberately not a sub-sequence match. `机械硬盘4t` is not a sub-sequence of
 * `西数4T机械硬盘` (the `4t` comes first), and a rule that loose would let the
 * rail back in.
 */
export const queryTerms = (query: string): string[] => {
  const q = String(query ?? '').normalize('NFKC').toLowerCase().trim();
  if (!q) return [];
  const CJK = '\\u3400-\\u9fff';
  // whitespace, and every CJK<->Latin boundary, so `i350网卡` splits into `i350` + `网卡`
  const runs = q.split(new RegExp(`[\\s\\u3000]+|(?<=[a-z0-9])(?=[${CJK}])|(?<=[${CJK}])(?=[a-z0-9])`, 'g'))
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  // A bare number and the unit stuck to it are one quantity, not two terms:
  // `显示器24寸` is `显示器` + `24寸`, not `显示器` + `24` + `寸`. Split them and
  // every listing has to carry the unit separately -- and `寸` alone then
  // qualifies titles about entirely different objects.
  const terms: string[] = [];
  for (const run of runs) {
    const prev = terms[terms.length - 1];
    const isUnit = new RegExp(`^[${CJK}]{1,2}$`).test(run);
    if (prev && /^[0-9]+$/.test(prev) && isUnit) terms[terms.length - 1] = prev + run;
    else terms.push(run);
  }
  return [...new Set(terms)];
};
/**
 * Does this title carry every term of the query, in any order? A one-word query
 * is an exact match, so the two rules only differ on multi-term ones.
 */
export const hasAllTerms = (title: string, terms: string[]): boolean => {
  const clean = (s: string) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const t = clean(title);
  return terms.every((x) => t.includes(clean(x)));
};
/**
 * Search step 1: find the SPA's own input, mark it, focus it.
 *
 * Measured over 12 loads, the homepage is a 512-character footer-only shell for
 * 8-14s and the real app then mounts, so "there is no input yet" is the normal
 * state for the first ten seconds. The caller polls; it must not conclude
 * anything from one miss.
 *
 * Selection is by geometry, not by class name. The classes are hashed per build
 * (search-input--WY2l9QD3), no placeholder is set at all, and an <input> at least
 * 100px wide within the top 400px of the viewport is the input -- it is the only
 * one there.
 *
 * Focused rather than clicked, and that is not a style choice: goofish's login
 * dialog puts an ant-modal-mask over the header and Playwright's click
 * actionability check times out against it (measured, 10s timeout, element
 * resolved but never receiving the event). `focus()` needs no pointer, and the
 * keys that follow are the ones the SPA's form listens for.
 */
export const SEARCH_INPUT_JS = (mark: string): any => {
  const { document, window, location } = globalThis as any;
  const cands = [...document.querySelectorAll('input')].filter((el: any) => {
    const r = el.getBoundingClientRect();
    return r.width >= 100 && r.height >= 20 && r.top < Math.min(400, window.innerHeight);
  });
  const el = cands.sort((a: any, b: any) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
  if (!el) return { found: false, inputs: document.querySelectorAll('input').length, chars: (document.body?.innerText || '').length, path: location.pathname };
  el.setAttribute(mark, '1');
  el.focus();
  // `value` is read off the live element the caller is about to type into, so the caller can confirm
  // the keys arrived instead of assuming they did. The SPA re-renders this input under the cursor,
  // and a keystroke burst that spans a re-render splits -- measured, "thinkpad x220" arriving as "th".
  return { found: true, focused: document.activeElement === el, value: String(el.value ?? ''), inputs: document.querySelectorAll('input').length, chars: (document.body?.innerText || '').length, path: location.pathname };
};

/**
 * Search step 3: everything the submit poll needs, in one round-trip. `typed` is read off the same
 * element step 1 marked, so "the keys never reached the input" is distinguishable from "Enter did not
 * submit" -- two different retries, and the measured log has both. A destroyed execution context (the
 * SPA swaps it on navigation) throws rather than answers; that is the poll's problem, not a failure,
 * and the caller keeps waiting.
 */
export const SEARCH_STATE_JS = (mark: string): any => {
  const { document, location } = globalThis as any;
  const el = document.querySelector(`[${mark}]`) as any;
  return {
    typed: el?.value ?? '',
    path: location.pathname,
    on_search: location.pathname.includes('/search'),
    cards: document.querySelectorAll('a[href*="/item?id="]').length,
  };
};

/** Is the page's own mtop client up yet? */
export const MTOP_READY_JS = (): string => {
  const { window } = globalThis as any;
  return window?.lib?.mtop?.request ? 'ready' : 'pending';
};

/**
 * item_view scrolls down and back so the lazy gallery photos decode first: the scraper filters on
 * naturalWidth, and an undecoded image reports 0.
 */
export const SCROLL_TO_JS = (y: number): void => { (globalThis as any).scrollTo(0, y); };

/**
 * A generic mtop call through the page's own client. `spec.calls` is a list of [label, api, data], so
 * one round-trip can fetch a batch of feed pages. They go out concurrently: sequentially, `pages: 25`
 * at ~10s each blew the 240s evaluate bound even though every call had succeeded. The answer is keyed
 * by label and every caller reads it by label, so concurrency is a drop-in.
 */
export const MTOP_CALL_JS = async (spec: { calls: [string, string, any][] }): Promise<any> => {
  const { window } = globalThis as any;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !window?.lib?.mtop?.request; i++) await wait(150);
  if (!window?.lib?.mtop?.request) return { fatal: 'mtop-not-ready' };
  const one = async ([label, api, data]: [string, string, any]): Promise<[string, any]> => {
    try {
      const res = await window.lib.mtop.request({ api, data, type: 'POST', v: '1.0', dataType: 'json', needLogin: false, needLoginPC: false, sessionOption: 'AutoLoginOnly', ecode: 0 });
      const ret = Array.isArray(res?.ret) ? res.ret.join(' | ') : String(res?.ret ?? '');
      return [label, { ret, ok: ret.includes('SUCCESS'), data: res?.data ?? null }];
    } catch (e) {
      // A rejected mtop call still carries goofish's own code on `ret`. That is the diagnostic; the
      // JS error message would throw it away.
      const ret = (e as any)?.ret;
      return [label, { ret: Array.isArray(ret) ? ret.join(' | ') : String(ret ?? (e as any)?.message ?? e), ok: false, data: null }];
    }
  };
  return Object.fromEntries(await Promise.all(spec.calls.map(one)));
};

// Payload normalisers. Not in-page scripts: these run here, in Node, over a response the page already
// produced. They exist because the DOM could not answer two questions properly. Plain functions,
// because nothing here touches a global.

const asText = (v: any): string => String(v ?? '').replace(/\s+/g, ' ').trim();
const firstText = (...vals: any[]): string => { for (const v of vals) { const s = asText(v); if (s) return s; } return ''; };
/**
 * goofish reports a count of 0 both when it genuinely has none and when it has nothing to report, and
 * the two read the same, so a 0 is published as a number and a missing key as an empty string.
 */
const countOf = (v: any): string => { if (v === null || v === undefined || String(v).trim() === '') return ''; const n = Number(v); return Number.isFinite(n) && n >= 0 ? String(Math.trunc(n)) : ''; };

    // Typed views of a listing. Everything above hands back the site's own strings, and those are what
    // the flat fields publish and every existing consumer reads; they are not retyped, because a field
    // that changes type under a caller is a breaking change wearing a version number. These publish
    // the same values beside them: `366` next to `"366"`. Never called from inside an in-page script.
export type ListingTyped = {
  price_amount: number | null;
  original_price_amount: number | null;
  image_count: number | null;
  want_count: number | null;
  view_count: number | null;
  collect_count: number | null;
  condition: string | null;
  published_at: string | null;
  updated_at: string | null;
  location: { province: string | null; city: string | null } | null;
  shipping: { fee: number | null; free_shipping: boolean | null } | null;
  seller_stats: { tenure_years: number | null; items_sold: number | null; positive_rate: number | null; reply_rate_24h: number | null; zhima_verified: boolean | null } | null;
};
/** A flat listing, the typed view of it, and the leaves of that view the site left out. */
export type TypedListing<T> = T & { price_info: PriceInfo; typed: ListingTyped; missing: string[] };

/**
 * A number, or null. The site sends numbers as strings and decorates them -- `"1,299"`, `"¥9"`,
 * `"12.50"`, `"80%"` -- so the decoration is stripped rather than the value called unreadable.
 *
 * An empty value is null and never 0. "The site said none" and "the site said nothing" are different
 * facts, and collapsing them is how a listing ends up looking free. That is also why the leftovers
 * have to look like a number rather than merely survive `Number`: `Number('')` is 0 and
 * `Number('面议')` is NaN, so a value that was *only* decoration -- a bare `¥`, an all-whitespace
 * field -- would come back as a price of zero.
 */
export const numberOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).normalize('NFKC').replace(/[,，\s¥￥%]/g, '');
  const match = s.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([万千亿kKmM]?)$/);
  if (!match) return null;
  const units: Record<string, number> = { '': 1, 千: 1000, 万: 10000, 亿: 100000000, k: 1000, m: 1000000 };
  const n = Number(match[1]) * units[match[2].toLowerCase()];
  return Number.isFinite(n) ? n : null;
};

/** Only explicit amounts normalize; prose, deposits, and ambiguous offers stay unknown. */
export type PriceInfo = { raw: string; currency: 'CNY'; kind: 'exact' | 'approximate' | 'range' | 'negotiable' | 'unknown'; amount: number | null; min_amount: number | null; max_amount: number | null };
export const priceOf = (raw: unknown): PriceInfo => {
  const text = asText(raw), clean = text.normalize('NFKC').replace(/(?:元|人民币|RMB|CNY)$/i, '').trim();
  const amount = numberOrNull(clean);
  const base = { raw: text, currency: 'CNY' as const, amount: null, min_amount: null, max_amount: null };
  if (amount !== null && amount >= 0) return { ...base, kind: /[万千亿kKmM]/.test(clean) ? 'approximate' : 'exact', amount };
  if (/^(面议|议价|negotiable)$/i.test(text)) return { ...base, kind: 'negotiable' };
  const range = clean.match(/^([¥￥]?\s*\d[\d,.]*(?:万|千)?)\s*[-~～至]\s*([¥￥]?\s*\d[\d,.]*(?:万|千)?)$/);
  if (range) {
    const min = numberOrNull(range[1]), max = numberOrNull(range[2]);
    if (min !== null && max !== null && min <= max) return { ...base, kind: 'range', min_amount: min, max_amount: max };
  }
  return { ...base, kind: 'unknown' };
};

/**
 * An ISO 8601 timestamp, or null. goofish stamps epochs in milliseconds (`"1784640276000"`), in
 * seconds on some payloads, and occasionally hands back a date already formatted. The digit count
 * picks the unit rather than the magnitude, and an already-ISO value passes through rather than
 * through `Date` a second time. Anything else is null, not a plausible-looking invention.
 */
export const isoOrNull = (v: unknown): string | null => {
  const s = asText(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  const d = /^\d{1,13}$/.test(s) ? new Date(Number(s) * (s.length <= 10 ? 1000 : 1)) : new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

/**
 * `{province, city}`, or null when the payload named no place at all. The province stays null unless
 * the payload carried one: it is deliberately *not* parsed out of the city string. A province inferred
 * from a city name is an invented fact, and an invented fact inside a structured field is worse than
 * a missing one, because the structure says it was read.
 */
const locationOf = (province: unknown, city: unknown): ListingTyped['location'] => {
  const p = asText(province) || null, c = asText(city) || null;
  return p || c ? { province: p, city: c } : null;
};

/**
 * The seller's statistics as numbers, or null when the source had none of them -- a feed card names a
 * seller and says nothing about them. `zhima_verified` passes through only when the payload really
 * carried a boolean, so "not verified" is never manufactured out of an absent key.
 */
const sellerStatsOf = (row: any): ListingTyped['seller_stats'] => {
  const tenure_years = numberOrNull(row.seller_tenure_years), items_sold = numberOrNull(row.seller_items_sold);
  const positive_rate = numberOrNull(row.seller_positive_rate), reply_rate_24h = numberOrNull(row.seller_reply_rate_24h);
  const zhima_verified = typeof row.seller_zhima_verified === 'boolean' ? row.seller_zhima_verified : null;
  return tenure_years === null && items_sold === null && positive_rate === null && reply_rate_24h === null && zhima_verified === null
    ? null : { tenure_years, items_sold, positive_rate, reply_rate_24h, zhima_verified };
};

/**
 * The shipping answer, or null. `free_shipping` is derived rather than scraped, and only ever from a
 * fee the payload carried: a transport fee of zero is free shipping on this site, and a fee that was
 * never rendered leaves both null rather than "free".
 */
const shippingOf = (fee: unknown): ListingTyped['shipping'] => {
  const f = numberOrNull(fee);
  return f === null ? null : { fee: f, free_shipping: f === 0 };
};

/**
 * Build the typed block from whatever flat fields a normaliser produced. Pure, total and idempotent,
 * which is what lets one function serve all four listing routes: the detail API, a feed card, a
 * search card and a DOM-scraped card each hand it a different subset of the same names.
 */
export const listingTyped = (row: any): ListingTyped => ({
  price_amount: priceOf(row.price).amount,
  original_price_amount: priceOf(row.original_price).amount,
  image_count: numberOrNull(row.image_count) ?? (Array.isArray(row.image_urls) && row.image_urls.length ? row.image_urls.length : null),
  want_count: numberOrNull(row.want_count),
  view_count: numberOrNull(row.browse_count),
  collect_count: numberOrNull(row.collect_count),
  condition: asText(row.condition) || null,
  published_at: isoOrNull(row.publish_time),
  updated_at: isoOrNull(row.gmt_modified),
  location: locationOf(row.province, firstText(row.city, row.seller_city)),
  shipping: shippingOf(row.shipping_fee),
  seller_stats: sellerStatsOf(row),
});

/**
 * Every leaf of a typed block that came back null, as dotted paths (`"seller_stats.items_sold"`). The
 * convention in one list: a null in `typed` is a value the site did not render, and this names it, so
 * a caller never has to guess whether a null is an absence or an oversight. A leaf present beside
 * absent siblings is named on its own (`location.province` while `location.city` is there). A null
 * *object* is named once at its own path: the source had none of it, and enumerating its keys would
 * say a dozen times what the null already says.
 */
export const missingPaths = (typed: any, prefix = ''): string[] => {
  if (typed === null || typed === undefined) return prefix ? [prefix] : [];
  if (typeof typed !== 'object' || Array.isArray(typed)) return [];
  return Object.entries(typed).flatMap(([k, v]) => missingPaths(v, prefix ? `${prefix}.${k}` : k));
};

/**
 * The row plus its typed view and the list of what the site did not render. Applied on this side of
 * the page boundary on purpose: the normalisers inside `FEED_NORMALIZE_JS` cannot close over these,
 * and typing the values there would mean a second copy of the rules to drift.
 */
export const enrichListing = <T extends Record<string, any>>(row: T): TypedListing<T> => {
  const typed = listingTyped(row);
  return { ...row, price_info: priceOf(row.price), typed, missing: missingPaths(typed) };
};

/**
 * One listing out of the captured `mtop.taobao.idle.pc.detail` payload, or null when the payload is
 * not a listing at all.
 *
 * This is why item_view is honest now. The DOM could not be made to yield a title: the detail block
 * renders the price, the description and the seller, but the title is not in the page's text at all --
 * measured, 6 live listings, `title` empty every time -- and the image selector returned goofish's
 * promo banners rather than the seller's photos. The API's `itemDO` has both, exact, plus about
 * fifteen fields the DOM never exposed: the seller's signature, reply rate, item count and avatar,
 * the 品牌/成色/已用年限 attribute block, favourites, quantity and shipping.
 *
 * `wanted` is the id the caller asked for, and it is checked here rather than trusted: the page
 * decides which listing to render, and a page that served a different one must not be reported as
 * the answer to this question.
 */
export const detailListing = (data: any, wanted: string): any | null => {
  const item = data?.itemDO, seller = data?.sellerDO || data?.b2cSellerDO || {};
  const id = asText(item?.itemId);
  if (!id) return null;
  if (wanted && id !== String(wanted)) return null;
  const images: string[] = [];
  for (const info of Array.isArray(item.imageInfos) ? item.imageInfos : []) {
    const u = asText(info?.url).replace(/^http:\/\//, 'https://');
    if (u && !images.includes(u)) images.push(u);
  }
  // cpvLabels is the 品牌 / 成色 / 已用年限 / 功能状态 block the detail page prints one label per
  // line.
  const attributes: Record<string, string> = {};
  for (const l of Array.isArray(item.cpvLabels) ? item.cpvLabels : []) {
    const k = asText(l?.propertyName), v = asText(l?.valueName);
    if (k && v) attributes[k] = v;
  }
  const tenure = Number(seller.userRegDay);
  return {
    item_id: id,
    title: asText(item.title),
    price: firstText(item.soldPrice, item.defaultPrice, item.originalPrice),
    original_price: Number(item.originalPrice) > 0 ? asText(item.originalPrice) : '',
    description: firstText(item.desc, item.richTextDesc),
    want_count: countOf(item.wantCnt),
    browse_count: countOf(item.browseCnt),
    collect_count: countOf(item.collectCnt),
    quantity: countOf(item.quantity),
    item_status: asText(item.itemStatusStr),
    shipping_fee: firstText(item.transportFee),
    // The raw sources the typed block reads, kept here rather than typed here so there is exactly one
    // place that turns a string into a number or a timestamp -- and so a route that cannot reach them
    // (the DOM card) publishes the same keys as null rather than a differently-shaped answer.
    publish_time: firstText(item.gmtCreate, item.publishTime),
    gmt_modified: firstText(item.gmtModified),
    province: firstText(seller.province, seller.provinceName),
    seller: asText(seller.nick),
    seller_city: firstText(seller.city, seller.publishCity),
    seller_tenure_years: Number.isFinite(tenure) && tenure > 0 ? String(Math.floor(tenure / 365)) : '',
    seller_items_sold: countOf(seller.hasSoldNumInteger),
    seller_items_listed: countOf(seller.itemCount),
    seller_positive_rate: asText(seller.newGoodRatioRate).replace('%', ''),
    seller_reply_rate_24h: asText(seller.replyRatio24h).replace('%', ''),
    seller_signature: asText(seller.signature),
    seller_avatar: asText(seller.portraitUrl).replace(/^http:\/\//, 'https://'),
    seller_last_active: asText(seller.lastVisitTime),
    seller_zhima_verified: seller.zhimaAuth === true,
    // Not in `ITEM_FIELDS`, so `fields_present` / `fields_missing` are unchanged. This is the one hop
    // from a listing to the seller behind it. `sellerId` is goofish's plain numeric user id (`kcUserId`
    // in the profile payload, the `userId` /personal?userId= takes); measured live, a detail reply's
    // sellerDO carries `sellerId` and no `userId`/`userIdStr` at all.
    seller_id: asText(seller.sellerId),
    brand: asText(attributes['品牌']),
    condition: asText(attributes['成色']),
    used_years: asText(attributes['已用年限']),
    attributes,
    image_urls: images,
  };
};

/**
 * The tags out of an `xyh.item.list` card's `itemLabelDataVO`: the strip goofish prints under the
 * title -- "2人想要", "验货宝", "卖家信用极好". Same idea as the search card's `fishTags` reader on a
 * different key, which is why it is its own function: `labelData` is `{r1: {tagList: [...]}, r3: ...}`
 * and each tag's text is at `tagList[].data.content`.
 *
 * The icon-name filter is not optional here. This function started without it and shipped a
 * `freeShippingIcon` as if it were a fact about the listing -- caught by a live run, not by a test. An
 * `img` tag carries its label text in `content` and its icon name in a sibling field, but free
 * shipping arrives as a bare `content: 'freeShippingIcon'` with no text at all, so the only way to
 * tell the two apart is the same `/Icon$/` rule the `fishTags` reader already uses.
 */
const labelContents = (labelData: any): string[] => {
  const out: string[] = [];
  for (const group of Object.values(labelData ?? {})) {
    for (const t of (group as any)?.tagList ?? []) {
      const c = asText(t?.data?.content);
      if (c && !/Icon$/.test(c) && !out.includes(c)) out.push(c);
    }
  }
  return out;
};

/**
 * The listings one seller currently has up, out of a captured `mtop.idle.web.xyh.item.list` payload.
 *
 * Deliberately not `FEED_NORMALIZE_JS`. That reader puts `detailParams.title` first in its title
 * chain, because on a feed or search card that is the listing title -- and here it is not always:
 * this endpoint's `cardData.title` is what goofish renders as the listing name, and for a seller who
 * typed prose into it ("专柜入手，穿过几次…") that prose *is* the title, on both fields. Reading them
 * through the feed normaliser would also have re-derived a web `url` this endpoint never sends: its
 * own `detailUrl` is a `fleamarket://` app deep link that no browser can open.
 *
 * `totalCount` is in the payload and is always 0 -- measured, two page sizes, a seller with six live
 * listings -- so it is not read here. `nextPage` is the field that does work.
 *
 * A `SUCCESS` reply with no `cardList` at all is this endpoint's way of saying "no listings on this
 * page": measured, page 2 of a six-listing seller came back `SUCCESS` with `cardList` absent and
 * every other key present. So the caller must not read a missing card list as a shape change --
 * which is exactly what the first version of `seller_items` did, and a live run turned it into a
 * `ParseError` for the most ordinary call there is. Cards with no id are dropped, so a renamed
 * `detailParams` shortens the list instead of publishing listings without one.
 */
export const sellerListings = (data: any): any[] => {
  const cards: any[] = [];
  for (const entry of Array.isArray(data?.cardList) ? data.cardList : []) {
    const card = entry?.cardData || entry || {};
    const dp = card.detailParams || {};
    const itemId = asText(dp.itemId) || asText(card.id);
    if (!itemId) continue;
    const images: string[] = [];
    for (const u of [dp.picUrl, card.picInfo?.picUrl]) {
      const s = asText(u).replace(/^http:\/\//, 'https://');
      if (s && !images.includes(s)) images.push(s);
    }
    // "2人想要" is the only place a want count appears on this card, and it is prose rather than a
    // number -- read as one, and left empty when the label is an image badge with no count in it.
    const want = String(labelContents(card.itemLabelDataVO?.labelData).find((t) => /人想要/.test(t)) ?? '').match(/([\d.]+)\s*(万)?\s*人想要/);
    cards.push({
      item_id: itemId,
      title: firstText(card.title, dp.title),
      price: firstText(dp.soldPrice, card.priceInfo?.price),
      category_id: asText(card.categoryId),
      want_count: want ? countOf(want[2] ? Number(want[1]) * 10_000 : Number(want[1])) : '',
      tags: labelContents(card.itemLabelDataVO?.labelData),
      image_urls: images,
      url: `https://www.goofish.com/item?id=${itemId}`,
    });
  }
  return cards;
};

/**
 * The profile out of a captured `mtop.idle.web.user.page.head` payload -- the endpoint the
 * /personal?userId= page calls for itself, which answers anonymously and is reachable through the
 * page's own mtop client from a page that never calls it.
 *
 * One field is deliberately not read. `module.base.ipLocation` looks like the seller's city and is
 * not: it is where goofish thinks *this request* came from. Measured live, it answered `上海市` for a
 * seller whose own detail record says `北京`, because the probe was leaving Shanghai. Publishing it
 * would put a wrong city in a field an agent would reasonably trust, and it would be wrong in the
 * most confident way possible. The seller's own city is on the item page's `sellerDO`, which is
 * where `seller_profile` reads it from -- see `SELLER_PROFILE_FIELDS`.
 *
 * The rest is the seller's standing: credit tier, shop level and score, praise ratio and review
 * count, follower and listing counts, and which identity checks they have passed. `praiseRatio` is
 * a bare number (100) where `newGoodRatioRate` on the detail payload is the same figure as a string
 * with a `%` on it, so the percent sign is dropped here to match the other counts.
 */
export const sellerProfileOf = (data: any): any => {
  const module = data?.module || {}, base = module.base || {}, shop = module.shop || {}, social = module.social || {}, tabs = module.tabs || {};
  const tags = data?.baseInfo?.tags || {};
  const credit = (role: string): string => firstText(...(Array.isArray(base.ylzTags) ? base.ylzTags : []).filter((t: any) => t?.attributes?.role === role).map((t: any) => t?.text));
  return {
    user_id: asText(data?.baseInfo?.kcUserId),
    display_name: asText(base.displayName),
    avatar_url: asText(base.avatar?.avatar).replace(/^http:\/\//, 'https://'),
    signature: asText(base.introduction),
    seller_credit: credit('seller'),
    buyer_credit: credit('buyer'),
    level: asText(shop.level),
    level_score: countOf(shop.score),
    praise_ratio: asText(shop.praiseRatio).replace('%', ''),
    review_count: countOf(shop.reviewNum),
    listings_count: countOf(tabs.item?.number),
    ratings_count: countOf(tabs.rate?.number),
    followers: firstText(social.followers),
    following: firstText(social.following),
    // A tag that is absent and a tag that is false both mean "not verified", and both are published as
    // false: `verified` is a statement about the account, and an unanswered question is not a yes.
    verified_real_name: tags.real_name_certification_77 === true,
    verified_real_person: tags.real_person_certification_77 === true,
    verified_zhima: tags.idle_zhima_zheng === true,
  };
};

/**
 * The listings out of a captured `mtop.taobao.idlemtopsearch.pc.search` payload.
 *
 * A search result and a homepage feed card are the *same* shape underneath -- `detailParams` with
 * itemId, title, soldPrice, picUrl, userNick -- so one normaliser reads both. What the DOM scrape
 * threw away, and what this reply carried all along: a want count, a city, a seller, the seller's
 * avatar, the tag strip.
 */
export const searchListings = (data: any): any[] => {
  const list = Array.isArray(data?.resultList) ? data.resultList : [];
  const cards: any[] = [];
  for (const entry of list) {
    const main = entry?.data?.item?.main;
    const ex = main?.exContent;
    if (!ex) continue;
    const dp = ex.detailParams || {};
    const args = main.clickParam?.args || {};
    // The id is in three places and they do not all survive a shape change: `detailParams.itemId` is
    // normally there, `exContent.itemId` and `clickParam.args.item_id` are the fallbacks. Without them a
    // card whose `detailParams` is empty or renamed leaves the normaliser with no id and is dropped
    // silently, which is how a result set gets shorter than it should with nothing saying so.
    const itemId = asText(dp.itemId) || asText(ex.itemId) || asText(args.item_id);
    // Rebuilt into the *feed's* card shape -- `{ detailParams, attributeMap, city }` -- so the one
    // normaliser reads a search result and a feed listing alike. The price is the trap: a search card's
    // `detailParams` carries no `soldPrice`, it lives in `clickParam.args.price`, so a search that copies
    // `detailParams` across returns items with an empty price that look free.
    const soldPrice = asText(dp.soldPrice) || asText(args.price);
    const image = asText(dp.picUrl) || asText(ex.picUrl);
    // The seller is here and was being thrown away: the search card's `userNick` does not exist, the
    // name is `exContent.userNickName`, so search results came back with an empty seller.
    const seller = asText(ex.userNickName) || asText(dp.userNick);
    cards.push({
      detailParams: { ...dp, ...(itemId ? { itemId } : {}), ...(image ? { picUrl: image } : {}), ...(soldPrice ? { soldPrice } : {}), ...(seller ? { userNick: seller } : {}) },
      attributeMap: { wantNum: asText(ex.want) || asText(args.wantNum), cCatId: args.cCatId, categoryId: args.catId },
      city: asText(ex.area),
      // Not normaliser fields: the search card's own extra, carried through so one reply answers more
      // than a title and a price. All of it is free -- it is in the reply we already hold.
      _ex: {
        seller_avatar: asText(ex.userAvatarUrl).replace(/^http:\/\//, 'https://'),
        seller_shop: Boolean(ex.userFishShopLabel) || asText(args.userIsUseFishShopCard) === 'true',
        is_video: Boolean(ex.showVideoIcon || dp.isVideo === 'true' || ex.isVideo === true),
        is_auction: Boolean(ex.isAuction),
        publish_time: asText(args.publishTime),
        // The last three are the raw sources the typed block reads, carried the same way the rest are:
        // they are in the reply when the card has them, and the block publishes a null and names it in
        // `missing` when it does not. Nothing here invents a province from a city or a fee from a tag.
        province: asText(ex.province) || asText(args.province),
        condition: asText(ex.condition) || asText(args.condition) || asText(dp.condition),
        shipping_fee: asText(ex.transportFee) || asText(args.transportFee) || asText(dp.transportFee),
        // fishTags.r1..r4 is the strip under the title: free shipping, a price drop, seller credit.
        // Reading the `content` of each tag is the only way to get it, and it is genuinely useful for
        // triage -- "卖家信用极好" and "18天内降价" change how a listing reads.
        tags: tagContents(ex.fishTags),
        page: asText(args.page),
      },
    });
  }
  return cards;
};

/** The text of every tag in a card's `fishTags` block, de-duplicated in document order. */
const tagContents = (fishTags: any): string[] => {
  const out: string[] = [];
  for (const group of Object.values(fishTags ?? {})) {
    for (const t of (group as any)?.tagList ?? []) {
      const c = asText(t?.data?.content);
      // `content` is sometimes an icon name rather than text (freeShippingIcon); an icon is not a fact.
      if (c && !/Icon$/.test(c) && !out.includes(c)) out.push(c);
    }
  }
  return out;
};

/**
 * Click the Nth box of the search results pager.
 *
 * The only way past 30 results, and the one click in this server. Two things make it safe. It is a
 * DOM `click()` rather than a Playwright pointer click, so the anonymous login dialog's
 * `ant-modal-mask` cannot intercept it -- the same reason nothing else here clicks anything, and
 * the reason those four close controls are left alone. And it is the search page's own pagination
 * control, not a dismissal: the page then issues its own `idlemtopsearch.pc.search` for the next
 * page, and the answer is read off the wire exactly as the first page's was.
 *
 * Measured: 30 new items per click, 5–9.5s, zero overlap with the page before, against 13–25s for a
 * fresh page load. Four tabs doing this concurrently gained nothing -- 8.2s per listing either way --
 * because goofish throttles per IP, so this is walked serially on the one dom page.
 *
 * Only boxes 1..10 are always rendered (the pager shows `1 2 3 4 5 6 7 8 9 10 ... 50`), which is why
 * `search_items` caps `pages` at 10. That is 300 listings, well past the 50 a comparison needs.
 */
export const PAGER_CLICK_JS = (spec: { page: string }): any => {
  const { document } = globalThis as any;
  const want = String(spec.page);
  const boxes = Array.from(document.querySelectorAll('[class*="search-pagination-page-box"]'));
  const active = boxes.find((b: any) => String(b.className).includes('active'));
  const el = boxes.find((b: any) => String((b as any).innerText ?? '').trim() === want);
  if (!el) return { ok: false, why: 'no such page box', on_page: String((active as any)?.innerText ?? '').trim(), have: boxes.map((b: any) => String((b as any).innerText ?? '').trim()).filter(Boolean).slice(0, 14) };
  if (el === active) return { ok: true, already: true, on_page: want };
  (el as any).click();
  return { ok: true, on_page: want };
};

/**
 * What the pager currently offers, so a caller can tell "there are no more pages" from "it went
 * wrong" without guessing from a timeout.
 */
export const PAGER_STATE_JS = (): any => {
  const { document } = globalThis as any;
  const boxes = Array.from(document.querySelectorAll('[class*="search-pagination-page-box"]'))
    .map((b: any) => String((b as any).innerText ?? '').trim()).filter(Boolean);
  const active = Array.from(document.querySelectorAll('[class*="search-pagination-page-box"]'))
    .find((b: any) => String((b as any).className).includes('active'));
  return { pages_visible: boxes, on_page: String((active as any)?.innerText ?? '').trim() };
};


/**
 * Normalise a cardList into flat listing dicts. The feed mixes two card layouts and neither is
 * guaranteed: A) detailParams {itemId, title, soldPrice, picUrl, userNick} + attributeMap, and
 * B) itemId + titleSummary.text + priceInfo.price + images[].url + user.userNick. Every field is
 * read through a fallback chain across both shapes. Measured on 60 live cards: 58 A, 2 B.
 */
export const FEED_NORMALIZE_JS = (spec: { rows: any[] }): any[] => {
  const clean = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const pick = (...vals: any[]) => { for (const v of vals) { const s = clean(v); if (s) return s; } return ''; };
  const out: any[] = [];
  for (const row of spec.rows) {
    const card = row?.cardData || row || {};
    const am = card.attributeMap || {}, dp = card.detailParams || {}, ex = card._ex || {};
    const itemId = pick(dp.itemId, card.itemId, am.itemId, am.uniqueCode);
    if (!itemId) continue;
    const imageUrls: string[] = [];
    const addImage = (u: any) => { const s = clean(u); if (s && !imageUrls.includes(s)) imageUrls.push(s); };
    addImage(pick(dp.picUrl, card.picUrl, am.picUrl, card.mainPicInfo?.url));
    for (const arr of [dp.imageList, card.imageList, am.imageList, card.images]) {
      if (Array.isArray(arr)) for (const e of arr) addImage(typeof e === 'string' ? e : (e?.url || e?.picUrl || e?.src || ''));
    }
    // hotPoint.text looks like "26人想要"; attributeMap.wantNum is the raw number.
    const hot = clean(card.hotPoint?.text).match(/([\d.]+)\s*(万)?\s*人想要/);
    out.push({
      item_id: itemId,
      title: pick(dp.title, card.titleSummary?.text, card.title, am.title, card.titleText),
      price: pick(dp.soldPrice, am.soldPrice, am.firstPrice, card.priceInfo?.price, card.price),
      original_price: pick(am.originalPrice, dp.originalPrice, card.priceInfo?.oriPrice),
      city: pick(card.city, dp.city, am.city),
      want_count: pick(am.wantNum, dp.wantNum, hot ? String(hot[2] ? Math.round(parseFloat(hot[1]) * 10000) : Math.round(parseFloat(hot[1]))) : ''),
      image_count: String(imageUrls.length || am.image_count || ''),
      seller: pick(dp.userNick, card.user?.userNick, am.userNick),
      // `ex.showVideoIcon` is how a search card says it; the feed card has no such field, hence the
      // three-way read rather than a replacement.
      is_video: pick(dp.isVideo, am.isVideo) === 'true' || Boolean(card.videoInfo) || Boolean(ex.is_video),
      is_auction: Boolean(ex.is_auction),
      category_id: pick(card.categoryId, dp.categoryId),
      image_urls: imageUrls,
      // Search cards carry more than a homepage feed card, and it is all in hand already: the seller's
      // avatar, the tag strip under the title (free shipping, a price drop, seller credit), when it
      // was listed, which result page it came from. A feed card has none of these, so they come back
      // empty rather than guessed.
      tags: Array.isArray(ex.tags) ? ex.tags : [],
      seller_avatar: pick(ex.seller_avatar),
      seller_shop: Boolean(ex.seller_shop),
      publish_time: pick(ex.publish_time),
      // The three the typed block reads, through the same fallback chain as everything else, and empty
      // when the card carries none of them -- the normal case for a homepage feed card, published as a
      // null in `typed` and an entry in `missing`, never guessed from the title.
      province: pick(ex.province, dp.province, am.province, card.province),
      condition: pick(ex.condition, dp.condition, am.condition, card.condition),
      shipping_fee: pick(ex.shipping_fee, dp.transportFee, am.transportFee, card.transportFee),
      url: 'https://www.goofish.com/item?id=' + itemId,
    });
  }
  return out;
};

/** Scrape an item's detail block from the rendered page. The recommendation rail follows the detail
 * block, so parsing the whole page can mistake a recommended item's title or price for the listing's.
 * Class names are build-specific; selectors use stable substrings and candidates must also appear in
 * the detail text, since the detail block and rail can share a container. */
export const ITEM_SCRAPE_JS = (spec: { item_id: string; rails: string[] }): any => {
  const { document, location } = globalThis as any;
  const clean = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim();
  // goofish puts the listing's name in the document title with a `_闲鱼` suffix, and truncates it.
  const asTitleText = (t: any) => clean(String(t ?? '').replace(/_闲鱼$/, ''));
  // `.../photo.jpg_2`, `.../photo.jpg_Q`, `.../photo.jpg_110x10000Q90.jpg_.webp` are all the same
  // photo as `.../photo.jpg`, so the size descriptor is dropped and the gallery collapses to one
  // entry per photo instead of listing each one three times.
  const bareImageUrl = (u: string) => (u.match(/^(.*?\.(?:jpe?g|png|webp))(?:_[^/]*)?$/i) || [null, u])[1] || '';
  const full = document?.body?.innerText || '';
  const cut = full.search(new RegExp(spec.rails.join('|')));   // spec.rails, not a second list of our own: see RAIL_MARKERS
  const head = cut >= 0 ? full.slice(0, cut) : full;
  const headCompact = head.replace(/\s+/g, ' ');
  const inDetail = (el: any) => { const t = clean(el.textContent); return Boolean(t) && t.length <= 200 && headCompact.includes(t); };
  // A "description" of "3人想要" is a want-counter that happens to sit in a class containing "desc",
  // not the seller's description.
  const isCounter = (s: string) => /^[\d.,]+\s*(人想要|浏览|人付款|人浏览)$/.test(clean(s));
  const firstInDetail = (sels: string[]) => {
    for (const s of sels) for (const el of document.querySelectorAll(s)) if (inDetail(el)) return clean(el.textContent);
    return '';
  };
  const money = (re: RegExp) => { const m = headCompact.match(re); if (!m) return ''; const n = parseFloat(m[1].replace(/,/g, '')); return Number.isNaN(n) ? '' : String(m[2] ? Math.round(n * 10000) : Math.round(n)); };
  const priceMatch = headCompact.match(/¥\s*([\d,]+(?:\.\d+)?)/);
  // The title is absent from the detail text, so use the document title if no detail selector matches.
  const docTitle = asTitleText(document?.title);
  // Seller uploads use `/bao/uploaded/`; CDN banners and avatars do not. Normalize thumbnail variants.
  const railImages = new Set<string>();
  const anchors = document.querySelectorAll("a[href*='/item?id=']");
  for (const a of anchors) for (const img of a.querySelectorAll('img')) if (img.src) railImages.add(img.src);
  const imageUrls: string[] = [];
  let wideOutsideCards = 0;
  for (const img of document.querySelectorAll('img')) {
    if (!img.src || railImages.has(img.src)) continue;
    if (!/\/bao\/uploaded\//.test(img.src)) continue;
    if (img.naturalWidth < 100) continue;   // an undecoded image reports 0, which is "not loaded yet", not "not a photo"
    const bare = bareImageUrl(img.src);
    if (bare && !imageUrls.includes(bare)) imageUrls.push(bare);
    wideOutsideCards++;
  }

  const stats = headCompact.match(/来闲鱼\s*([\d.]+)\s*年[^ ]*\s*卖出\s*([\d]+)\s*件宝贝?\s*好评率\s*([\d.]+)%/);
  return {
    requested_item_id: String(spec.item_id),
    // The page's own id, so the caller can check it got the listing it asked for rather than a
    // redirect, a challenge page or a different item.
    page_item_id: (location?.search?.match(/[?&]id=([0-9]+)/) || location?.pathname?.match(/\/item\/([0-9]+)/) || [])[1] || '',
    detail_rendered: /人想要|浏览|立即购买/.test(headCompact),
    // Two pages look like "not ready yet" and are not. goofish serves a "网络不见了" notice when its own
    // edge fails, and a cached shell can hold nothing but rail cards under a `为你推荐` heading in the
    // first few characters -- which cut the head to 3 chars and made a real listing look empty. Both
    // are instant and retryable, so both are named instead of polled for another 32s.
    site_error: /网络不见了|服务异常|页面不存在|网络异常/.test(full),
    rail_only: cut >= 0 && cut < 120,
    title: firstInDetail(['[class*="main-title"]', '[class*="item-title"]', '[class*="detail-title"]', 'h1']) || docTitle,
    price: priceMatch ? priceMatch[1].replace(/,/g, '') : '',
    want_count: money(/([\d.]+)\s*(万)?\s*人想要/),
    browse_count: money(/([\d.]+)\s*(万)?\s*浏览/),
    description: (() => {
      for (const s of ['[class*="desc--"]', '[class*="item-desc"]', '[class*="detail-desc"]', '[class*="main-desc"]']) {
        for (const el of document.querySelectorAll(s)) {
          if (!inDetail(el)) continue;
          const txt = clean(el.textContent);
          if (!isCounter(txt) && txt.length >= 4) return txt;
        }
      }
      return '';
    })(),
    seller: firstInDetail(['[class*="nick"]', '[class*="user-name"]']),
    seller_tenure_years: stats ? stats[1] : '',
    seller_items_sold: stats ? stats[2] : '',
    seller_positive_rate: stats ? stats[3] : '',
    image_urls: imageUrls,
    // diagnostic: how many large non-card images the page had at all, so an empty image_urls can be
    // told apart from a gallery that never loaded
    image_candidates: wideOutsideCards,
    head_preview: headCompact.slice(0, 220),
    reco_anchors: anchors.length,
  };
};

/** Scrape item cards from a rendered page for search and recommendation tools. Search uses
 * `query_hits` and `cards_scanned` to reject unrelated recommendation rails; `token_hits` also reports
 * titles containing every query term in any order. Counts cover the whole page even when `items` is
 * limited. The selector table stays inside this function because Playwright serializes it on its own.
 * Reading `innerText` and querying the DOM does not require dismissing the login overlay. */
export const SCRAPE_CARDS_JS = (spec: { query: string; terms: string[]; groups?: string[][]; limit: number; rails: string[] }): any => {
  const { document } = globalThis as any;
  const clean = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const sel = { card: 'a[href*="/item?id="]', title: '[class*="row1-wrap-title"], [class*="main-title"]', attrs: '[class*="row2-wrap-cpv"] span[class*="cpv--"]', priceWrap: '[class*="price-wrap"]', priceNum: '[class*="number"]', priceDec: '[class*="decimal"]', sellerWrap: '[class*="row4-wrap-seller"]', sellerText: '[class*="seller-text"]' };
  // `spec.terms`, not a tokenizer of its own: Playwright serialises the function and its argument
  // and nothing else, so the one rule that decides what counts as a match has to be handed in --
  // otherwise the page and the caller can disagree about what a query means, and did.
  const q = String(spec.query || '').toLowerCase(), terms = (spec.terms || []).map((t: any) => String(t).toLowerCase());
  const seen = new Set<string>();
  const items: any[] = [];
  let queryHits = 0, tokenHits = 0, cards = 0;
  for (const card of document.querySelectorAll(sel.card)) {
    const href = card.href || card.getAttribute('href') || '';
    const id = (href.match(/[?&]id=([0-9]+)/) || [])[1];
    if (!id || seen.has(id)) continue;
    const title = clean(card.querySelector(sel.title)?.textContent) || clean(card.innerText).slice(0, 90);
    if (!title) continue;
    seen.add(id);
    cards++;
    const low = title.toLowerCase();
    // Two different questions, and the difference is the whole search: does the title contain the
    // query as one phrase, or every term of it in any order. On this site the second is the one that
    // matches real listings, because sellers do not use the searcher's word order.
    const has_phrase = Boolean(q) && low.includes(q);
    const normalized = low.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
    const groups = spec.groups || terms.map((t: string) => [t]);
    const has_terms = groups.length > 0 && groups.every((g: string[]) => g.some(t => normalized.includes(t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))));
    if (has_phrase) queryHits++;
    if (has_terms) tokenHits++;
    if (items.length >= spec.limit) continue;   // keep counting, stop collecting: the fraction needs the whole page
    const priceWrap = card.querySelector(sel.priceWrap);
    const attrs = Array.from(card.querySelectorAll(sel.attrs)).map((n: any) => clean(n.textContent)).filter(Boolean);
    // No per-item `source`: a card is a match or it is not, and the envelope's `source` says where
    // the set came from. Labelling every card "dom_recommendation" once made search results claim to
    // be recommendations.
    items.push({
      item_id: id,
      title,
      price: clean('¥' + clean(priceWrap?.querySelector(sel.priceNum)?.textContent) + clean(priceWrap?.querySelector(sel.priceDec)?.textContent)).replace(/^¥\s*$/, ''),
      condition: attrs[0] || '',
      brand: attrs[1] || '',
      city: clean(card.querySelector(sel.sellerWrap)?.querySelector(sel.sellerText)?.textContent),
      url: href,
      matches_query: has_phrase || has_terms,
      matches_phrase: has_phrase,
    });
  }
  const text = document?.body?.innerText || '';
  return {
    items,
    query_hits: queryHits,
    token_hits: tokenHits,
    cards_scanned: cards,
    rail: spec.rails.find((m) => text.includes(m)) || '',
    says_no_results: /没有找到你想要的宝贝|未找到相关宝贝|没有找到相关/.test(text),
    // Measured, not guessed: goofish answers this client with a whole-page risk-control notice instead
    // of the app -- "非法访问 ... 请使用正常浏览器访问闲鱼" -- a 200 that renders no listing at all. The
    // mtop client still comes up on it, so the mtop-only tools keep working while every DOM tool sees
    // zero cards, which reads exactly like "no results found" unless it is named.
    blocked: /非法访问|使用正常浏览器|访问闲鱼/.test(text),
    rendered: items.length > 0,
    text_preview: text.slice(0, 200),
  };
};
