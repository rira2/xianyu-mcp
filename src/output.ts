/**
 * Output shaping for a search answer: the compact card, the price statistics and the sorts.
 *
 * Everything here is a pure function over the envelope `searchItems` has already built. It is applied
 * at the tool boundary (`TOOLS`, `search_items`) and never inside `searchItems`, because `detail`
 * enrichment and the filter re-checks must keep reading full cards: compacting first would drop the
 * `typed` block the prices and the filters come from, and re-open the filter contract. `compact` here
 * is the output mode, not `search-policy.ts`'s title-normalisation helper.
 */

export type SortMode = 'relevance' | 'price_asc' | 'price_desc' | 'newest';

export type PriceStats = {
  count: number; min: number; p10: number; p25: number; median: number; p75: number; p90: number; max: number;
  mean: number; currency: 'CNY';
};

/**
 * The price a listing was offered at, or null. `typed.price_amount` is the only source read: the flat
 * `price` string is the site's own text and re-parsing it here would give a scan's statistics to a
 * second copy of the parser. A non-finite number is not a price.
 */
const priceAmountOf = (item: any): number | null => {
  const amount = item?.typed?.price_amount;
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
};

/** A finite number from a flat string field, or null -- an absent or unreadable value is unknown,
 *  never zero. */
const numOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** The published moment of a listing, in epoch milliseconds, or null. goofish stamps this field in
 *  milliseconds; a card that carries none is unknown rather than old. */
const timestampOf = (item: any): number | null => {
  const stamp = item?.publish_time;
  if (typeof stamp !== 'string' && typeof stamp !== 'number') return null;
  const value = Number(stamp);
  return stamp !== '' && Number.isFinite(value) ? value : null;
};

/** Same rule as `scripts/bench-lib.mjs`'s `percentile`: k = (n-1)q, then interpolate between the
 *  closest ranks. The caller passes an ascending array and never an empty one. */
const percentile = (sorted: number[], q: number): number => {
  const k = (sorted.length - 1) * q;
  const floor = Math.floor(k), ceil = Math.min(floor + 1, sorted.length - 1);
  return sorted[floor] + (sorted[ceil] - sorted[floor]) * (k - floor);
};
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** The title length a compact card defaults to, and the range a caller may ask for. */
export const DEFAULT_TITLE_MAX_LEN = 120;
export const TITLE_MAX_LEN_FLOOR = 40;
export const TITLE_MAX_LEN_CEILING = 500;

/** Clamp a requested title length: 0 keeps the whole title, anything else is held to 40..500. */
export const titleMaxLenOf = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(TITLE_MAX_LEN_CEILING, Math.max(TITLE_MAX_LEN_FLOOR, Math.trunc(n)));
};

/**
 * One listing as a deal scan keeps it: what it is, what it costs, where it is, how wanted it is, who
 * sells it and how to open it. `price_amount` rides along only when the typed block has one, so an
 * unreadable price stays absent rather than becoming a zero. The same rule governs every optional
 * block: a field absent from the site stays absent here rather than arriving as a zero or a false.
 *
 * Two things are shaping rather than data. `title` is truncated to `titleMaxLen` (default 120, 0 for
 * the whole thing) because a search card's title genuinely carries the seller's description/SEO spam
 * -- measured at 300+ characters -- while `title_len` preserves the original length so nothing
 * silently reads as a short title. And the numeric twins (`price_amount`, `want_count_num`, the seller
 * rates) exist because a compact card has no `typed` block to read numbers from; the raw strings stay
 * beside them.
 *
 * Seller rates are published under names that say which metric they are: `seller_card_good_rate` /
 * `seller_card_reviews` came off the card's shop label, and `seller_good_rate` / `seller_positive_rate`
 * are the lifetime figures a detail read carries. They are different numbers for the same seller and
 * must never share a name.
 */
export const compactItem = (item: any, opts: { titleMaxLen?: number } = {}): any => {
  const amount = priceAmountOf(item);
  const title = typeof item?.title === 'string' ? item.title : String(item?.title ?? '');
  const titleChars = Array.from(title);
  const titleMax = opts.titleMaxLen === undefined ? DEFAULT_TITLE_MAX_LEN : titleMaxLenOf(opts.titleMaxLen);
  const cardGood = numOrNull(item?.seller_card_good_rate), cardReviews = numOrNull(item?.seller_card_reviews);
  const goodRate = numOrNull(item?.seller_good_rate), lifetime = numOrNull(item?.seller_positive_rate);
  const reply = numOrNull(item?.seller_reply_rate_24h), replyRaw = typeof item?.seller_reply_rate_24h_raw === 'string' ? item.seller_reply_rate_24h_raw : '';
  const sold = numOrNull(item?.seller_items_sold), tenure = numOrNull(item?.seller_tenure_years);
  const user = numOrNull(item?.seller_user_id);
  const quantity = numOrNull(item?.quantity), fee = numOrNull(item?.shipping_fee), wants = numOrNull(item?.want_count);
  return {
    item_id: item?.item_id, rank: item?.rank,
    title: titleMax === 0 ? title : titleChars.slice(0, titleMax).join(''), title_len: titleChars.length,
    price: item?.price,
    ...(amount === null ? {} : { price_amount: amount }),
    city: item?.city, want_count: item?.want_count,
    ...(wants === null ? {} : { want_count_num: wants }),
    seller: item?.seller, url: item?.url,
    // Card-derived trust signals: the opaque seller id (group listings by seller across queries), the
    // site's recent good-rate label, the shop label, and profile flags. Absent when not sent.
    ...(item?.seller_id ? { seller_id: item.seller_id } : {}),
    ...(cardGood === null ? {} : { seller_card_good_rate: cardGood }),
    ...(cardReviews === null ? {} : { seller_card_reviews: cardReviews }),
    ...(item?.seller_credit ? { seller_credit: item.seller_credit } : {}),
    ...(item?.seller_identity ? { seller_identity: item.seller_identity } : {}),
    ...(item?.seller_shop ? { seller_shop: true } : {}),
    ...(item?.seller_hidden ? { seller_hidden: true } : {}),
    // Detail-derived: the lifetime rate (`seller_positive_rate` is the legacy name for it), the reply
    // rate (null when the site printed a floor, with the raw words beside it), the numeric seller id
    // and the standing counts. `seller_card_*` above is never filled from these.
    ...(goodRate === null ? {} : { seller_good_rate: goodRate }),
    ...(lifetime === null ? {} : { seller_positive_rate: lifetime }),
    ...(reply !== null ? { seller_reply_rate_24h: reply } : replyRaw ? { seller_reply_rate_24h: null } : {}),
    ...(replyRaw ? { seller_reply_rate_24h_raw: replyRaw } : {}),
    ...(user === null ? {} : { seller_user_id: user }),
    ...(sold === null ? {} : { seller_items_sold: sold }),
    ...(tenure === null ? {} : { seller_tenure_years: tenure }),
    ...(item?.seller_zhima_verified === true ? { seller_zhima_verified: true } : {}),
    // Detail-only listing facts: the search payload never carries them, so a card that was not
    // deepened omits both rather than reporting a quantity of zero.
    ...(quantity === null ? {} : { quantity }),
    ...(item?.item_status ? { item_status: String(item.item_status) } : {}),
    ...(item?.item_status_token ? { item_status_token: item.item_status_token } : {}),
    // Shipping: the evidence a card can support (tag/title, with `shipping_source` saying which) and
    // the exact fee when the detail read had one.
    ...(typeof item?.free_shipping === 'boolean' ? { free_shipping: item.free_shipping } : {}),
    ...(item?.shipping_source ? { shipping_source: item.shipping_source } : {}),
    ...(fee === null ? {} : { shipping_fee: fee }),
    // The tag strip, kept raw for compatibility, and the facts it was split into.
    ...(Array.isArray(item?.tags) && item.tags.length ? { tags: item.tags } : {}),
    ...(item?.condition ? { condition: item.condition } : {}),
    ...(Array.isArray(item?.badges) && item.badges.length ? { badges: item.badges } : {}),
    ...(item?.price_drop ? { price_drop: item.price_drop } : {}),
    ...(item?.attributes && Object.keys(item.attributes).length ? { attributes: item.attributes } : {}),
    ...(item?.publish_time ? { publish_time: item.publish_time } : {}),
  };
};

/**
 * The distribution of what the result set actually costs, or null when nothing in it carried a
 * readable price -- an inventory with no prices is not an inventory of zeroes. `count` is the number
 * of listings measured, which is not the number returned: unknown prices are left out of every
 * figure rather than treated as cheap.
 */
export const priceStats = (items: any[]): PriceStats | null => {
  const prices = (Array.isArray(items) ? items : []).map(priceAmountOf)
    .filter((amount): amount is number => amount !== null).sort((a, b) => a - b);
  if (!prices.length) return null;
  return {
    count: prices.length, min: prices[0], p10: percentile(prices, 0.1), p25: percentile(prices, 0.25),
    median: percentile(prices, 0.5), p75: percentile(prices, 0.75), p90: percentile(prices, 0.9),
    max: prices[prices.length - 1], mean: round2(prices.reduce((sum, amount) => sum + amount, 0) / prices.length), currency: 'CNY',
  };
};

/**
 * A copy of the listings in the requested order. `price_asc`/`price_desc` sort on the typed price and
 * `newest` on the publish stamp; a listing whose value is unknown goes last in either direction,
 * because an unreadable price is neither the cheapest nor the most recent one. Only a real sort
 * renumbers `rank`, so `relevance` keeps the server's own ranking rather than a meaningless 1..n of
 * the same order.
 */
export const sortItems = (items: any[], sort: SortMode): any[] => {
  const copy = [...items];
  if (sort === 'relevance') return copy;
  const key = sort === 'newest' ? timestampOf : priceAmountOf;
  const descending = sort === 'price_desc' || sort === 'newest';
  copy.sort((a, b) => {
    const left = key(a), right = key(b);
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    return descending ? right - left : left - right;
  });
  return copy.map((item, index) => ({ ...item, rank: index + 1 }));
};

/**
 * The envelope a search caller gets, shaped at the boundary. `price_stats` is always added, over the
 * whole result set, before any sort or compaction. A non-`relevance` `sort` reorders and renumbers the
 * items. `compact` replaces each card with `compactItem`, then drops the two blocks that exist for
 * diagnosis rather than for the answer -- the per-attempt log (the attempt count stays) and the
 * sampled titles inside `diagnostics` -- and says so with `compact: true`. Everything else, including
 * `count`, `next_cursor` and `freshness`, is passed through untouched.
 */
export const shapeSearchData = (data: Record<string, any>, opts: { compact?: boolean; sort?: SortMode; titleMaxLen?: number }): Record<string, any> => {
  const out: Record<string, any> = { ...data };
  const items = Array.isArray(data.items) ? data.items : [];
  const sort = opts.sort ?? 'relevance';
  out.price_stats = priceStats(items);
  if (sort !== 'relevance' && Array.isArray(data.items)) out.items = sortItems(items, sort);
  if (!opts.compact) return out;
  out.compact = true;
  if (Array.isArray(out.items)) out.items = out.items.map((item) => compactItem(item, { titleMaxLen: opts.titleMaxLen }));
  delete out.attempt_log;
  if (out.diagnostics && typeof out.diagnostics === 'object' && !Array.isArray(out.diagnostics)) {
    const diagnostics = { ...out.diagnostics };
    delete diagnostics.sample_titles;
    out.diagnostics = diagnostics;
  }
  return out;
};
