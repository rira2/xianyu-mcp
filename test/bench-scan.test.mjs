/**
 * The harness exists so that every later change is measured the same way, which makes the arithmetic
 * in these helpers the part worth testing: a success rate rounded the wrong way, or a total that
 * double-counts a failed query, would quietly rewrite a benchmark's conclusion. The stdio client in
 * `bench-scan.mjs` is proved against a real server by the live smoke run, not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTable, parseSpec, percentile, summarize } from '../scripts/bench-lib.mjs';

const rows = () => [
  { slug: 'p100', ok: true, status: 'success', count: 60, ms: 1000, bytes: 100000 },
  { slug: 'v100', ok: true, status: 'success', count: 60, ms: 1000, bytes: 100000 },
  { slug: 'p40', ok: false, status: 'error', count: 0, ms: 1000, bytes: 100000 },
];

test('parseSpec keeps the queries a benchmark file was written to measure', () => {
  assert.deepEqual(
    parseSpec(JSON.stringify([
      { slug: 'p100', query: 'Tesla P100 16G', pages: 2, limit: 60 },
      { slug: 'x220', query: 'thinkpad x220' },
    ])),
    [
      { slug: 'p100', query: 'Tesla P100 16G', pages: 2, limit: 60 },
      { slug: 'x220', query: 'thinkpad x220' },
    ],
  );
});

test('parseSpec names the field a malformed entry is missing', () => {
  assert.throws(() => parseSpec('[{"slug":"x"}]'), /spec entry 1: missing query/);
  assert.throws(() => parseSpec('[{"query":"thinkpad x220"}]'), /spec entry 1: missing slug/);
});

test('parseSpec refuses text that is not a spec rather than measuring nothing', () => {
  assert.throws(() => parseSpec('{"slug":"x","query":"y"}'), /spec: expected a JSON array/);
  assert.throws(() => parseSpec('<html>'), /spec: not valid JSON/);
});

test('summarize counts the successes, adds the listings and bytes, and rounds the rate', () => {
  assert.deepEqual(summarize(rows()), {
    queries: 3,
    ok: 2,
    failed: 1,
    listings: 120,
    bytes: 300000,
    wall_ms: 3000,
    success_rate: 0.6667,
  });
});

test('percentile interpolates between the closest ranks and does not sort the caller array', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  const values = [4, 1, 3, 2];
  assert.equal(percentile(values, 0.5), 2.5);
  assert.deepEqual(values, [4, 1, 3, 2], 'the helper must sort a copy, not the caller array');
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
  assert.equal(percentile([], 0.5), 0);
});

test('formatTable prints one line per query and a totals line that adds up', () => {
  const out = formatTable(rows());
  for (const slug of ['p100', 'v100', 'p40']) assert.ok(out.includes(slug), `missing ${slug}`);
  assert.match(out, /p40\s+ok=false\s+status=error\s+count=0/);
  assert.match(out, /TOTAL\s+queries=3\s+ok=2\s+failed=1\s+listings=120\s+bytes=300000/);
  assert.equal(out.split('\n').length, 4, 'three query lines plus the totals line');
});
