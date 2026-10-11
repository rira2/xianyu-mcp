/** Process-local TTL caches for full item details and raw search pages.
 *
 * Both keys identify the answer (item id, or query and page). Cached values use the same identity and
 * relevance checks as live responses. Failed or unparseable responses are never stored.
 *
 * Search counts, suggestions, seller endpoints, and the homepage feed are not cached. The first three
 * take 0.4-2.2s; repeated feed calls return disjoint inventory. Item details use a 45s default TTL
 * because prices can change or listings can sell. Search pages use 120s: they are not transaction
 * data, and item details are checked again before use. These values are configurable with
 * `XIANYU_CACHE_ITEM_TTL_S` and `XIANYU_CACHE_SEARCH_TTL_S`; `XIANYU_CACHE=0` disables both caches.
 *
 * Every cache-aware answer publishes a `CacheVerdict`, including hit state, key, age and TTL. Misses
 * use the same shape with null age fields. */
type Entry = { value: any; stored: number };

/** What every answer this cache touches publishes about itself. `hit` is the contract; the rest lets
 *  a caller see how old the answer is and what it was keyed on. */
export type CacheVerdict = {
  /** true only when this value came out of this process rather than off goofish. */
  hit: boolean;
  /** What it was keyed on, `item:809806779491` or `search:thinkpad x220#2`, so a miss reads as
   *  "a different thing was asked for" rather than "the cache is broken". */
  key: string;
  /** Whole seconds since the value was stored. null on a miss: a miss has no age. */
  age_s: number | null;
  /** ISO 8601, or null on a miss. */
  stored_at: string | null;
  /** The TTL in force for this call, so an answer says how old it was allowed to get. */
  ttl_s: number;
  /** One sentence, always, saying whether goofish was asked. */
  note: string;
};

/** Separate stores keep each cache's size visible in `stats`; search pages and listings also have
 *  different TTLs and memory costs. */
const items = new Map<string, Entry>(), pages = new Map<string, Entry>();
/** Enough entries for a 50-item detail request and a 12-page search walk, with some spare capacity. */
const MAX_ITEMS = 64, MAX_SEARCH_PAGES = 16;
/** An override is floored at 1s so a typo cannot turn the cache into a no-op that still claims to be
 * on, and capped at 600s so it cannot restore a window no measurement here supports. `0` is how you
 *  ask for the whole thing off -- see `on()`. */
const TTL_FLOOR_S = 1, TTL_CEILING_S = 600;
const DEFAULT_ITEM_TTL_S = 45, DEFAULT_SEARCH_TTL_S = 120;

/** Is the cache on at all? `XIANYU_CACHE=0` is the kill switch, and it is the first thing every read
 *  asks, so switching it off needs no restart and no code change. */
export const on = (): boolean => process.env.XIANYU_CACHE !== '0';
/** Read per call, like `budget`: an integer in seconds, otherwise the default. */
const ttl = (name: string, fallback: number): number => {
  const raw = process.env[name], n = Number(raw);
  return raw?.trim() && Number.isInteger(n) ? Math.max(TTL_FLOOR_S, Math.min(TTL_CEILING_S, n)) : fallback;
};
/** How long a listing read may be served again. See the header for why 45s and why not more. */
export const itemTtl = (): number => ttl('XIANYU_CACHE_ITEM_TTL_S', DEFAULT_ITEM_TTL_S);
/** How long one page of search results may be served again. See the header. */
export const searchTtl = (): number => ttl('XIANYU_CACHE_SEARCH_TTL_S', DEFAULT_SEARCH_TTL_S);

/** Copy values at the cache boundary so callers cannot mutate stored entries. */
const copy = <T>(value: T): T => (value === null || typeof value !== 'object' ? value : structuredClone(value));

/** Insert, then evict the least recently used entry if the store is over its cap. Re-inserting on
 *  read as well as on write is what makes the eviction LRU rather than oldest-written, so re-opening
 *  the listing you are working on keeps its place. */
const store = (into: Map<string, Entry>, key: string, value: any, cap: number): void => {
  into.delete(key);
  into.set(key, { value, stored: Date.now() });
  while (into.size > cap) into.delete(into.keys().next().value as string);
};
/** A live entry for this key, or null. An expired entry is deleted on the way past rather than left
 *  to be counted, so `stats` cannot report a window the cache would not actually serve. */
const load = (from: Map<string, Entry>, key: string, ttlS: number): Entry | null => {
  const hit = from.get(key);
  if (!hit) return null;
  const ageS = (Date.now() - hit.stored) / 1000;
  if (ageS >= ttlS) { from.delete(key); return null; }
  from.delete(key);
  from.set(key, hit);
  return hit;
};
const iso = (ms: number): string => new Date(ms).toISOString();
const seconds = (s: number): number => Math.round(s * 10) / 10;

/** Build a hit verdict. Keep fractional seconds so a recent entry is not reported as age zero. */
const hit = (key: string, entry: Entry, ttlS: number, what: string): CacheVerdict => {
  const ageS = seconds((Date.now() - entry.stored) / 1000);
  return { hit: true, key, age_s: ageS, stored_at: iso(entry.stored), ttl_s: ttlS,
    note: `${what} was served from this process's own cache, ${ageS}s old (TTL ${ttlS}s): goofish was not asked, so ${/^item:/.test(key) ? 'this listing may have been sold, repriced or edited since' : 'this page of results may no longer be what goofish would return'}. Re-read it with XIANYU_CACHE=0, or after the TTL.` };
};
/** A `hit: false` block, published for the same key so the envelope's shape does not depend on where
 *  the answer came from -- the same rule the `typed`/`missing` block follows per listing route. */
export const missed = (key: string, ttlS: number, what: string): CacheVerdict => ({
  hit: false, key, age_s: null, stored_at: null, ttl_s: ttlS,
  note: on() ? `${what} was not in the cache (or what was there is past its ${ttlS}s TTL), so goofish answered it live just now` : `the cache is off (XIANYU_CACHE=0), so ${what} was answered live just now` });
/** A `hit: false` block for a route that never consults the cache: search_items' rendered-page
 *  fallback, which scrapes the DOM rather than reading the search API's payload. Same shape as every
 *  other verdict so the envelope does not change with the route, and an empty `key` because nothing
 *  was looked up. */
export const notCached = (what: string, ttlS: number): CacheVerdict => ({
  hit: false, key: '', age_s: null, stored_at: null, ttl_s: ttlS,
  note: `${what} was answered live from the rendered page; this route neither reads nor writes the cache, so nothing was looked up and nothing was stored` });

export const itemKey = (itemId: string): string => `item:${itemId}`;
/** The key is the *normalized* query, lowercased, because the relevance guard it will be pooled
 *  through matches titles case-insensitively ("X220" and "x220" are the same search). Keying on the
 *  raw string would store the same page twice and serve half of it never. */
export const searchKey = (query: string, page: number): string => `search:${String(query).trim().toLowerCase()}#${page}`;

/** A listing read earlier in this process, or null. `readListing` asks this before it opens a page,
 *  and that is the whole saving: a repeat view costs nothing instead of 4-10s. */
export const getItem = (itemId: string): { value: any; verdict: CacheVerdict } | null => {
  if (!on()) return null;
  const key = itemKey(itemId), ttlS = itemTtl(), entry = load(items, key, ttlS);
  if (!entry) return null;
  return { value: copy(entry.value), verdict: hit(key, entry, ttlS, 'this listing') };
};
/** Store a listing read just now. Called only with a listing goofish answered in full: the
 *  `search_card_cache` fallback deliberately does not come through here, because pinning a
 *  five-field card for the TTL would turn one degraded read into a window of them. */
export const putItem = (itemId: string, listing: any): void => { if (on() && listing) store(items, itemKey(itemId), copy(listing), MAX_ITEMS); };

/** One page of search results read earlier in this process, or null. */
export const getSearchPage = (query: string, page: number): { value: any; verdict: CacheVerdict } | null => {
  if (!on()) return null;
  const key = searchKey(query, page), ttlS = searchTtl(), entry = load(pages, key, ttlS);
  if (!entry) return null;
  return { value: copy(entry.value), verdict: hit(key, entry, ttlS, 'this page of results') };
};
/** Store one page of search results, keyed on the query and the pager page it was. */
export const putSearchPage = (query: string, page: number, payload: any): void => { if (on() && payload) store(pages, searchKey(query, page), copy(payload), MAX_SEARCH_PAGES); };

/** The `cache` block a pooled search answer publishes: one line per pager page, so which of the
 *  listings behind `count` were read when is visible rather than implied. Pages read at different
 *  moments happen here (page 1 fresh, page 3 ninety seconds old), and one age for the whole set
 *  would be a claim about a set that does not exist. */
export const observationAge = (lines: { age_s?: number | null; observed_at?: string | null }[]): number => Math.max(0, ...lines.map(l => {
  const stamp = l.observed_at ? Date.parse(l.observed_at) : NaN;
  return Number.isFinite(stamp) ? Math.max(0, (Date.now() - stamp) / 1000) : l.age_s ?? 0;
}));
export const pageReport = (lines: { page: number; hit: boolean; age_s: number | null; observed_at?: string | null }[]): Record<string, any> => {
  const ttlS = searchTtl(), hits = lines.filter((l) => l.hit);
  return { enabled: on(), hits: hits.length, misses: lines.length - hits.length, ttl_s: ttlS,
    pages: lines.map(l => ({ ...l, observation_age_s: observationAge([l]) })),
    note: hits.length === 0
      ? `every page below was read from goofish just now (nothing cached, or the cache is off; TTL ${ttlS}s)`
      : `${hits.length} of ${lines.length} page(s) were served from this process's own cache and the rest were read live just now; a cached page may no longer be what goofish would return, so read a listing before relying on its price (TTL ${ttlS}s)` };
};

/** What `capabilities` reports, so the cache is visible before it is relied on rather than first
 *  discovered inside a `cache` block on a tool answer. */
export const stats = (): Record<string, any> => ({ enabled: on(), item_ttl_s: itemTtl(), search_page_ttl_s: searchTtl(), listings: items.size, search_pages: pages.size,
  note: 'item detail and search pages are cached in this process for the TTLs above, and every answer that can come from the cache says so in a `cache` block. Set XIANYU_CACHE=0 to turn it off; nothing else in this server is cached, and the homepage feed deliberately is not -- goofish serves each visitor a different slice of it, so a repeat call is a different answer rather than a stale copy.' });

/** Forget everything. These stores are module state that outlives a call, so a test that seeded one
 *  would otherwise have the next tool answered from it -- the same reason `resetCardCache` exists. */
export const reset = (): void => { items.clear(); pages.clear(); };
