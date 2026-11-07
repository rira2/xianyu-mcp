/** Search controls shared by live, cached and rendered-page results. */
import { randomUUID } from 'node:crypto';
import { queryTerms } from './extract.ts';
import { XianyuError } from './errors.ts';

export const ALIASES: Record<string, string[]> = {
  xeon: ['xeon', '至强'], 至强: ['至强', 'xeon'],
};
// Related categories are suggestions, not interchangeable products.
export const QUERY_SUGGESTIONS: Record<string, string[]> = {
  服务器: ['工控'], 工控: ['服务器'], 显卡: ['计算卡'], 计算卡: ['显卡'],
};
export const compact = (value: unknown): string => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export const termGroups = (query: string, aliases = true): string[][] => queryTerms(query).map(t => aliases ? ALIASES[t] ?? [t] : [t]);
export const matchesGroups = (title: unknown, groups: string[][]): boolean => {
  const text = compact(title);
  return groups.length > 0 && groups.every(g => g.some(t => text.includes(compact(t))));
};
/**
 * Which rule a title has to satisfy. `all` is the long-standing one (every query term, any order),
 * `any` is the OR the field report asked for, and `phrase` is the whole query as one normalised run --
 * case, spaces and punctuation ignored, order kept. The names are the published `match_mode`.
 */
export const MATCH_MODES = ['all', 'any', 'phrase'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];
/** The whole query as one comparable run. Empty when the query has no letters or digits at all, and
 *  an empty phrase matches nothing: `''.includes('')` would otherwise admit every title on the page. */
const phraseRun = (query: unknown): string => compact(query);
export const titleMatches = (title: unknown, query: string, groups: string[][], mode: MatchMode): boolean => {
  const text = compact(title);
  if (mode === 'phrase') { const phrase = phraseRun(query); return Boolean(phrase) && text.includes(phrase); }
  if (mode === 'any') return groups.length > 0 && groups.some((g) => g.some((t) => text.includes(compact(t))));
  return matchesGroups(title, groups);
};
/** The rows a rule admits, in their original order. One function for all three so the tool, the
 *  relabelling and the post-detail re-check cannot disagree about what "matched" means. */
export const matchingRows = <T>(rows: T[], query: string, groups: string[][], mode: MatchMode): T[] =>
  rows.filter((row) => titleMatches((row as any)?.title, query, groups, mode));
/**
 * The terms a failed strict match still has in common: at least 60% of them, and never fewer than two.
 * This is the long-standing partial-term rescue, kept ahead of the OR-relax because it is the tighter
 * answer when it exists.
 */
export const partialTermRows = <T>(rows: T[], groups: string[][]): T[] => {
  const need = Math.max(2, Math.ceil(groups.length * 0.6));
  return rows.filter((row) => { const text = compact((row as any)?.title); return groups.filter((g) => g.some((t) => text.includes(compact(t)))).length >= need; });
};

/**
 * Is the relaxed relevance rule on? It is a deliberate exception to the strict guard, so it has a
 * visible name and one kill switch. Default on, because goofish's own search is fuzzy: `E5 2680 v4`
 * returns a page of E5 parts of which two are the CPU, and refusing the page throws away the exact
 * titles a shopper asked for. `XIANYU_RELAX_MATCH=0` restores the strict rule; only the literal `0`
 * turns it off, so an empty or misspelled value cannot silently change what a refusal means.
 */
export const relaxMatch = (env: NodeJS.ProcessEnv = process.env): boolean => env.XIANYU_RELAX_MATCH !== '0';
/**
 * The words a suggestion is rebuilt from: the caller's own spellings where the whitespace split lines
 * up with the query terms, and the normalised terms otherwise. `32G` stays `32G` and does not come
 * back as `32g`; a query cut at a CJK/Latin boundary (`机械硬盘4t`) has no whitespace to preserve, so
 * the terms are what is left.
 */
const termSpellings = (query: string, terms: string[]): string[] => {
  const words = String(query ?? '').normalize('NFKC').trim().split(/[\s\u3000]+/).filter(Boolean);
  return words.length === terms.length && words.every((w, i) => compact(w) === terms[i]) ? words : terms;
};
/**
 * The queries worth trying after this one returned nothing relevant, built only from the caller's own
 * words: drop each term that matched no title, spell a term the glossary already equates under its
 * other name, or name a related category the glossary records as a suggestion. Nothing else is
 * invented -- a single-term query that failed has no honest shorter form, so the list is empty rather
 * than a guess -- and the query that just failed is never offered back.
 */
export const suggestedQueries = (query: string, unmatched: string[] = [], aliases = true): string[] => {
  const terms = queryTerms(query), spellings = termSpellings(query, terms);
  const phrase = (parts: string[]) => parts.join(' ').trim();
  const out: string[] = [];
  const add = (value: string) => {
    const v = value.trim();
    if (v && compact(v) !== compact(query) && !out.some((x) => compact(x) === compact(v))) out.push(v);
  };
  // A dropped term only means something when another term is left: `RECC` minus `RECC` is not a query.
  if (terms.length > 1) for (const token of unmatched) {
    const at = terms.findIndex((t) => compact(t) === compact(token));
    if (at >= 0) add(phrase(spellings.filter((_, i) => i !== at)));
  }
  for (let i = 0; i < terms.length; i++) {
    if (aliases) for (const alt of ALIASES[terms[i]] ?? []) if (compact(alt) !== terms[i]) add(phrase(spellings.map((w, k) => (k === i ? alt : w))));
    for (const related of QUERY_SUGGESTIONS[terms[i]] ?? []) add(phrase(spellings.map((w, k) => (k === i ? related : w))));
  }
  return out.slice(0, 5);
};
export const queryDiagnostics = (query: string, rows: any[], aliases = true) => {
  const groups = termGroups(query, aliases);
  const tokens = groups.map((alternatives, i) => ({ token: queryTerms(query)[i], alternatives,
    matching_titles: rows.filter(row => matchesGroups(row.title, [alternatives])).length }));
  const unmatched_tokens = tokens.filter(t => t.matching_titles === 0).map(t => t.token);
  return { tokens, unmatched_tokens,
    // The next queries to try, computed from the same evidence the unmatched list reports: a failure
    // that names what did not match but not what might is half an answer.
    suggested_queries: suggestedQueries(query, unmatched_tokens, aliases),
    titles_inspected: rows.length, sample_titles: rows.slice(0, 5).map(r => String(r.title ?? '')),
    suggestions: [...new Set(queryTerms(query).flatMap(t => QUERY_SUGGESTIONS[t] ?? []))],
    note: 'Title matching ignores case, spaces and punctuation. Only explicit equivalents (Xeon/至强) expand automatically; related product categories are suggestions. suggested_queries are variations built from the query\'s own words, not a second search.' };
};

export type Filters = { min_price?: number; max_price?: number; city?: string; province?: string; exclude_keywords?: string[];
  form_factor?: 'pcie' | 'sxm2' | 'sxm3' | 'sxm4' | 'sxm5'; bare_card_only?: boolean };
export const hardwareOf = (title: unknown) => {
  const text = String(title ?? '').normalize('NFKC').toLowerCase();
  const sxm = text.match(/\bsxm\s*[- ]?([2-5])\b/);
  const pcie = /pci\s*[- ]?e|pcie|\bpcie\b/i.test(text);
  const form = sxm && pcie ? null : sxm ? `sxm${sxm[1]}` : pcie ? 'pcie' : null;
  const accessory = /散热|转接|延长|连接线|线材|水冷头|背板|空盒|支架|风扇|heatsink|adapter|cable|bracket/.test(text);
  const explicitBare = /裸卡|单卡|bare\s*card|card\s*only/.test(text);
  return { form_factor: form, bare_card: accessory ? false : explicitBare ? true : null,
    evidence: 'title_only', note: 'Unknown means the title does not establish this fact. Verify the listing and photos.' };
};
export const filterRows = (rows: any[], filters: Filters) => {
  const place = (value: unknown) => compact(value).replace(/(?:壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$/, '');
  const reasons: Record<string, number> = {};
  const reject = (reason: string) => { reasons[reason] = (reasons[reason] ?? 0) + 1; return false; };
  const items = rows.filter(row => {
    const price = row.typed?.price_amount;
    if ((filters.min_price !== undefined || filters.max_price !== undefined) && price == null) return reject('unknown_price');
    if (filters.min_price !== undefined && price < filters.min_price) return reject('below_min_price');
    if (filters.max_price !== undefined && price > filters.max_price) return reject('above_max_price');
    if (filters.city && place(row.typed?.location?.city) !== place(filters.city)) return reject('city');
    if (filters.province && place(row.typed?.location?.province) !== place(filters.province)) return reject('province');
    if (filters.exclude_keywords?.some(k => compact(row.title).includes(compact(k)))) return reject('excluded_keyword');
    const hardware = hardwareOf(row.title);
    if (filters.form_factor && hardware.form_factor !== filters.form_factor) return reject(hardware.form_factor ? 'form_factor' : 'unknown_form_factor');
    if (filters.bare_card_only && hardware.bare_card !== true) return reject(hardware.bare_card === false ? 'accessory' : 'unknown_bare_card');
    return true;
  }).map(row => ({ ...row, hardware: hardwareOf(row.title) }));
  return { items, filters: { applied: filters, scope: 'server_post_fetch', input_count: rows.length, excluded_count: rows.length - items.length, reasons,
    note: 'Goofish provides no verified upstream filter for this workflow. Filters run on fetched cards; missing facts fail a requested filter.' } };
};

// Opaque process-local continuation tokens; bounded storage, no client-supplied pager state.
type Continuation = { query: string; options: Record<string, any>; nextPage: number; pendingItems: any[]; observedAt: number; expires: number };
const cursors = new Map<string, Continuation>();
export const saveCursor = (query: string, options: Record<string, any>, nextPage: number, pendingItems: any[] = [], observedAt = Date.now()): string => {
  for (const [k,v] of cursors) if (v.expires <= Date.now()) cursors.delete(k);
  while (cursors.size >= 64) cursors.delete(cursors.keys().next().value!);
  const token = randomUUID(); cursors.set(token, { query, options: structuredClone(options), nextPage, pendingItems: structuredClone(pendingItems), observedAt, expires: Date.now() + 600_000 });
  return token;
};
export const readCursor = (token: string, query: string): Continuation => {
  const saved = cursors.get(token);
  if (!saved || saved.expires <= Date.now()) throw new XianyuError('cursor is unknown or expired; start a new search');
  if (saved.query !== query) throw new XianyuError('cursor belongs to a different query');
  return structuredClone(saved);
};
