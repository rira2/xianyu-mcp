/**
 * Pure helpers for the bulk-scan benchmark: turning a spec file into queries, turning result rows into
 * one summary, and rendering both for a terminal. Nothing here touches the filesystem, the network or
 * `process`; `bench-scan.mjs` owns all of that so these functions can be tested without a server.
 */

/**
 * Parse a spec file into the queries to run. `pages` and `limit` stay absent when the file omits them,
 * so the server's own defaults apply rather than a number the harness invented. Entry numbers in the
 * errors are 1-based because a person reading "entry 2" counts from one.
 */
export const parseSpec = (text) => {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`spec: not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('spec: expected a JSON array');
  return parsed.map((entry, index) => {
    const at = `spec entry ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at}: expected an object`);
    const { slug, query, pages, limit } = entry;
    if (typeof slug !== 'string' || !slug.trim()) throw new Error(`${at}: missing slug`);
    if (typeof query !== 'string' || !query.trim()) throw new Error(`${at}: missing query`);
    const out = { slug, query };
    if (pages !== undefined) {
      if (!Number.isInteger(pages) || pages < 1) throw new Error(`${at}: pages must be a positive integer`);
      out.pages = pages;
    }
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1) throw new Error(`${at}: limit must be a positive integer`);
      out.limit = limit;
    }
    return out;
  });
};

/**
 * Same rank rule as `stats.py`: `k = (n-1) * q`, then interpolate between the floor and the next rank.
 * The array is sorted as a copy so measuring percentiles cannot reorder a caller's data.
 */
export const percentile = (values, q) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const k = (sorted.length - 1) * q;
  const floor = Math.floor(k);
  const ceil = Math.min(floor + 1, sorted.length - 1);
  return sorted[floor] + (sorted[ceil] - sorted[floor]) * (k - floor);
};

/**
 * One row per query in, one machine-readable result out. `wall_ms` is the sum of the per-call times
 * because the calls are sequential, and a failed query still costs the wall time it burned.
 */
export const summarize = (rows) => {
  const ok = rows.filter((row) => row.ok === true).length;
  const queries = rows.length;
  return {
    queries,
    ok,
    failed: queries - ok,
    listings: rows.reduce((sum, row) => sum + row.count, 0),
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    wall_ms: rows.reduce((sum, row) => sum + row.ms, 0),
    success_rate: queries ? Math.round((ok / queries) * 10000) / 10000 : 0,
  };
};

/**
 * One line per query, then a totals line. Key=value fields rather than columns, because these lines
 * are as likely to be grepped or pasted into a report as they are to be read in a terminal.
 */
export const formatTable = (rows) => {
  const width = Math.max(5, ...rows.map((row) => row.slug.length));
  const lines = rows.map((row) => [
    row.slug.padEnd(width),
    `ok=${row.ok === true}`,
    `status=${row.status}`,
    `count=${row.count}`,
    `bytes=${row.bytes}`,
    `${(row.ms / 1000).toFixed(1)}s`,
  ].join('  '));
  const summary = summarize(rows);
  lines.push([
    'TOTAL'.padEnd(width),
    `queries=${summary.queries}`,
    `ok=${summary.ok}`,
    `failed=${summary.failed}`,
    `listings=${summary.listings}`,
    `bytes=${summary.bytes}`,
    `wall=${(summary.wall_ms / 1000).toFixed(1)}s`,
  ].join('  '));
  return lines.join('\n');
};
