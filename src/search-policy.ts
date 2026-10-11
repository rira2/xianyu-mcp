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
export const queryDiagnostics = (query: string, rows: any[], aliases = true) => {
  const groups = termGroups(query, aliases);
  const tokens = groups.map((alternatives, i) => ({ token: queryTerms(query)[i], alternatives,
    matching_titles: rows.filter(row => matchesGroups(row.title, [alternatives])).length }));
  return { tokens, unmatched_tokens: tokens.filter(t => t.matching_titles === 0).map(t => t.token),
    titles_inspected: rows.length, sample_titles: rows.slice(0, 5).map(r => String(r.title ?? '')),
    suggestions: [...new Set(queryTerms(query).flatMap(t => QUERY_SUGGESTIONS[t] ?? []))],
    note: 'Title matching ignores case, spaces and punctuation. Only explicit equivalents (Xeon/至强) expand automatically; related product categories are suggestions.' };
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
