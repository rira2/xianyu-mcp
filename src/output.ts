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

/**
 * One listing as a deal scan keeps it: what it is, what it costs, where it is, how wanted it is, who
 * sells it and how to open it. `price_amount` rides along only when the typed block has one, so an
 * unreadable price stays absent rather than becoming a zero. `tags` and `publish_time` are optional
 * because their absence is the common case, and an empty `tags` array would spend bytes saying nothing.
 */
export const compactItem = (item: any): any => {
  const amount = priceAmountOf(item);
  return {
    item_id: item?.item_id, rank: item?.rank, title: item?.title, price: item?.price,
    ...(amount === null ? {} : { price_amount: amount }),
    city: item?.city, want_count: item?.want_count, seller: item?.seller, url: item?.url,
    ...(Array.isArray(item?.tags) && item.tags.length ? { tags: item.tags } : {}),
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
export const shapeSearchData = (data: Record<string, any>, opts: { compact?: boolean; sort?: SortMode }): Record<string, any> => {
  const out: Record<string, any> = { ...data };
  const items = Array.isArray(data.items) ? data.items : [];
  const sort = opts.sort ?? 'relevance';
  out.price_stats = priceStats(items);
  if (sort !== 'relevance' && Array.isArray(data.items)) out.items = sortItems(items, sort);
  if (!opts.compact) return out;
  out.compact = true;
  if (Array.isArray(out.items)) out.items = out.items.map(compactItem);
  delete out.attempt_log;
  if (out.diagnostics && typeof out.diagnostics === 'object' && !Array.isArray(out.diagnostics)) {
    const diagnostics = { ...out.diagnostics };
    delete diagnostics.sample_titles;
    out.diagnostics = diagnostics;
  }
  return out;
};
