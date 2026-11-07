/**
 * Process-local listing history: which ids this server has already shown, and at what price.
 *
 * A bulk scan runs the same keyword list again a minute later, and the caller's next question is
 * always the same: what is new, and what got cheaper? Both are answered from memory here, not from
 * goofish. The store is a bounded `Map` keyed on `item_id` -- one entry per listing -- that keeps the
 * first time this process saw it and the last price it read, so `is_new` is a fact about this
 * process rather than a claim about the site. It is deliberately not persisted: a restart forgets
 * everything, and a first-ever scan is *all* new rather than all known.
 *
 * The store never guesses. An unknown price is not a drop, a price *increase* is not a drop, and an
 * observation that carries no readable price leaves the last one in place rather than erasing what
 * this process knew. Nothing here throws on shape: search cards arrive shaped (`price_amount`) or
 * unshaped (`typed.price_amount`), and both are read.
 *
 * `XIANYU_HISTORY=0` is the kill switch and is read per call, so it needs no restart. When it is
 * off, `annotate*` returns its input untouched: no `is_new`, no `history` block, and `new_only` has
 * no store to filter against (the README says so).
 */
import { priceStats } from './output.ts';

type Entry = { first_seen: number; price: number | null };
/** One observation's answer. `first_seen_age_s` is 0 for a listing this process had never seen. */
export type Observation = { is_new: boolean; first_seen_age_s: number; price_drop_amount: number | null; previous_price: number | null };

/** Capacity: 20,000 ids is roughly a year of daily 12-query scans without a restart, and the whole
 *  entry is two numbers plus a string key. One id over the line evicts the least recently seen. */
const CAPACITY = 20_000;
const listings = new Map<string, Entry>();
const round1 = (value: number): number => Math.round(value * 10) / 10;
/** `XIANYU_HISTORY !== '0'` -- on by default, so a caller gets novelty without asking for it. */
export const historyEnabled = (): boolean => process.env.XIANYU_HISTORY !== '0';

/** The price this card carries, or null. Only a finite number is a price: the flat `price` string is
 *  the site's own text, and re-parsing it here would give history a second parser to disagree with. */
const priceOf = (item: any): number | null => {
  // Shaped/compact cards carry `price_amount`; full cards carry `typed.price_amount`. Either is read,
  // and a missing or unreadable one falls through to the other rather than masking it.
  for (const amount of [item?.price_amount, item?.typed?.price_amount]) if (typeof amount === 'number' && Number.isFinite(amount)) return amount;
  return null;
};

/** Record one sighting and say how it compares to the last one. A card with no `item_id` cannot be
 *  linked to anything, so it is reported as not-new and never stored. */
export const observeListing = (item: any): Observation => {
  const neutral: Observation = { is_new: false, first_seen_age_s: 0, price_drop_amount: null, previous_price: null };
  const id = item?.item_id;
  if (!historyEnabled() || id === undefined || id === null || String(id) === '') return neutral;
  const key = String(id), now = Date.now(), seen = listings.get(key), price = priceOf(item);
  if (!seen) {
    listings.set(key, { first_seen: now, price });
    while (listings.size > CAPACITY) listings.delete(listings.keys().next().value as string);
    return { is_new: true, first_seen_age_s: 0, price_drop_amount: null, previous_price: null };
  }
  // The previous price is the last one *observed*, not the first: a drop is measured against the
  // price this process most recently quoted, which is the only comparison a caller can act on.
  const previous = seen.price;
  const drop = previous !== null && price !== null && price < previous ? round1(previous - price) : null;
  // Touch on read as well as on write, so re-seeing the listing a caller is watching keeps its place
  // and the eviction is least-recently-seen rather than oldest-first-written.
  listings.delete(key);
  listings.set(key, { first_seen: seen.first_seen, price: price ?? previous });
  return { is_new: false, first_seen_age_s: round1((now - seen.first_seen) / 1000), price_drop_amount: drop, previous_price: previous };
};

/** A drop observed in this answer, in the shape the published `price_drops` list uses. */
type Drop = { item_id: string; title: string | null; from: number; to: number; drop_amount: number; drop_percent: number | null };
const MAX_DROPS = 50;
const dropOf = (item: any, observed: Observation): Drop | null => {
  if (observed.price_drop_amount === null || observed.previous_price === null) return null;
  const to = priceOf(item);
  if (to === null) return null;
  const from = observed.previous_price;
  return {
    item_id: String(item.item_id), title: typeof item?.title === 'string' && item.title ? item.title : null,
    from, to, drop_amount: observed.price_drop_amount,
    drop_percent: from > 0 ? round1((observed.price_drop_amount / from) * 100) : null,
  };
};
/** The `history` block an annotated answer publishes. `price_drops` is capped and ordered by the
 *  largest absolute drop, because that is the one a deal scan wants first. */
const summary = (observed: { item: any; observation: Observation }[]): Record<string, any> => {
  const drops = observed.map(({ item, observation }) => dropOf(item, observation))
    .filter((drop): drop is Drop => drop !== null)
    .sort((a, b) => b.drop_amount - a.drop_amount || a.item_id.localeCompare(b.item_id))
    .slice(0, MAX_DROPS);
  return {
    tracked: listings.size,
    known_count: observed.filter(({ observation }) => !observation.is_new).length,
    new_count: observed.filter(({ observation }) => observation.is_new).length,
    price_drops: drops,
  };
};

/** Only the two marks a card publishes. `price_drop_amount`/`previous_price` are per-observation
 *  diagnostics that feed `history.price_drops`; they do not belong on every returned card. */
const mark = (item: any, observation: Observation): Record<string, any> => ({ ...item, is_new: observation.is_new, first_seen_age_s: observation.first_seen_age_s });

/** Annotate every card in an answer with `is_new`/`first_seen_age_s`. With `new_only`, keep only the
 *  listings this process had not seen before, so `count`, `price_stats` and `history.known_count`
 *  all describe what the answer actually returns. The caller's object is not mutated. */
export const annotateSearchData = (data: Record<string, any>, opts: { new_only?: boolean } = {}): Record<string, any> => {
  if (!historyEnabled()) return data;
  const items = Array.isArray(data.items) ? data.items : null;
  const observed = (items ?? []).map((item) => ({ item, observation: observeListing(item) }));
  const annotated = observed.map(({ item, observation }) => mark(item, observation));
  const kept = opts.new_only ? annotated.filter((item: any) => item.is_new) : annotated;
  const out: Record<string, any> = { ...data };
  if (items) out.items = kept;
  if (opts.new_only && items) {
    out.count = kept.length;
    // `priceStats` reads the typed block; a compact card keeps the same number flat, so restate it
    // in the shape the statistics understand rather than publishing figures over a filtered-out set.
    out.price_stats = priceStats(kept.map((item: any) => ({ typed: { price_amount: priceOf(item) } })));
  }
  out.history = summary(observed);
  return out;
};

/**
 * The same annotation for a batch: per-query `items`, then the call's totals.
 *
 * `totals.new_listings` and `totals.known_listings` count the listings the queries returned (a
 * duplicate across two queries is two returned listings, exactly as `totals.listings` counts them).
 * With `new_only`, each row keeps only its new listings and the item-derived totals are recomputed
 * from what is returned, so a row that had listings and now has none says `status: "empty"` and
 * `history.known_count` names how many known listings were suppressed. Rows the call never answered
 * (`error`, `skipped`) are left alone except for their annotation, and their partial cards are
 * observed too -- they were read from goofish and paid for.
 */
export const annotateBatchData = (data: Record<string, any>, opts: { new_only?: boolean } = {}): Record<string, any> => {
  if (!historyEnabled()) return data;
  const observed: { item: any; observation: Observation }[] = [];
  const queries = (Array.isArray(data.queries) ? data.queries : []).map((row: Record<string, any>) => {
    if (!Array.isArray(row?.items)) return row;
    const rows = row.items.map((item: any) => {
      const observation = observeListing(item);
      observed.push({ item, observation });
      return mark(item, observation);
    });
    const kept = opts.new_only ? rows.filter((item: any) => item.is_new) : rows;
    const out: Record<string, any> = { ...row, items: kept };
    if (opts.new_only) {
      out.count = kept.length;
      // `success`/`empty` are derived from the item count, so they have to move with it; a refusal
      // and a skipped query stay refusals.
      if (row.status === 'success' || row.status === 'empty') out.status = kept.length ? 'success' : 'empty';
      if ('price_stats' in row) out.price_stats = priceStats(kept);
    }
    return out;
  });
  const out: Record<string, any> = { ...data, queries };
  const totals = { ...(data.totals ?? {}) };
  const returned = queries.flatMap((row: Record<string, any>) => (Array.isArray(row.items) ? row.items : []));
  const known = returned.filter((item: any) => item.is_new === false).length;
  totals.new_listings = returned.filter((item: any) => item.is_new === true).length;
  totals.known_listings = known;
  if (opts.new_only) {
    const unique = new Set<string>();
    for (const item of returned) if (item?.item_id) unique.add(String(item.item_id));
    totals.listings = returned.length;
    totals.unique_listings = unique.size;
    totals.duplicates = totals.listings - totals.unique_listings;
    totals.ok = queries.filter((row: Record<string, any>) => row.status === 'success').length;
    totals.empty = queries.filter((row: Record<string, any>) => row.status === 'empty').length;
    out.count = totals.listings;
  }
  out.totals = totals;
  out.history = summary(observed);
  return out;
};

/** What `capabilities` reports, so history is visible before a scan has relied on it. */
export const stats = (): { enabled: boolean; tracked: number; capacity: number; note: string } => ({
  enabled: historyEnabled(), tracked: listings.size, capacity: CAPACITY,
  note: 'listing ids and the last price this process read are remembered in memory only; a restart forgets them, so a first-ever scan is all new. Set XIANYU_HISTORY=0 to turn the store off (new_only has nothing to filter against then).',
});

/** Forget everything. Module state outlives a call, so tests clear it between cases. */
export const reset = (): void => { listings.clear(); };
