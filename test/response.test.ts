import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { executeTool, OUTPUT_SCHEMA, resetCooldown } from '../src/response.ts';
import { GatedError } from '../src/errors.ts';
import { checkpoint, recordPartial, withDeadline } from '../src/runtime.ts';
import { exclusive } from '../src/browser.ts';
const schema = z.object(OUTPUT_SCHEMA);
const stub = (run: () => Promise<any>) => ({ name: 'fixture', schema: {}, run });
afterEach(resetCooldown);

test('failures and real empty results have the same keys and different statuses', async () => {
  const empty = await executeTool(stub(async () => ({ count: 0, items: [] })), {});
  const failure = await executeTool(stub(async () => { throw new GatedError('RGV587'); }), {});
  assert.deepEqual(Object.keys(empty).sort(), Object.keys(failure).sort());
  assert.equal(empty.status, 'empty'); assert.equal(empty.ok, true);
  assert.equal(failure.status, 'error'); assert.equal(failure.ok, false);
  assert.equal(failure.count, 0); assert.equal(failure.data, null);
  assert.equal(failure.diagnostics.reason, 'rate_limited'); assert.equal(failure.retry_after_s, 60);
  assert.equal(schema.safeParse(empty).success, true); assert.equal(schema.safeParse(failure).success, true);
});
test('empty shells, raw throws and invalid arguments cannot become successful results', async () => {
  const shell = await executeTool(stub(async () => ({})), {});
  assert.equal(shell.ok, false); assert.equal(shell.diagnostics.reason, 'unexpected_payload');
  const opaque = Object.create(null, { details: { get: () => { throw Error('getter'); } } });
  const raw = await executeTool(stub(async () => { throw opaque; }), {});
  assert.equal(raw.ok, false); assert.equal(raw.error_type, 'Error'); assert.ok(raw.message);
  let called = false;
  const invalid = await executeTool({ name: 'fixture', schema: { query: z.string().min(1) }, run: async () => { called = true; return {}; } }, { query: '' });
  assert.equal(called, false); assert.equal(invalid.diagnostics.reason, 'invalid_arguments');
});
test('every response identifies the loaded implementation, including local edits', async () => {
  const out = await executeTool(stub(async () => ({ items: [{ item_id: '1' }] })), {});
  assert.match(out.build.runtime_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(out.build.implementation, 'typescript'); assert.ok(out.build.version);
  assert.equal(out.count, 1); assert.equal(out.schema_version, 2);
});
test('observed throttling prevents another network attempt and leaves static capabilities available', async () => {
  await executeTool(stub(async () => { throw new GatedError('RGV587'); }), {});
  let invoked = false;
  const blocked = await executeTool(stub(async () => { invoked = true; return { items: [] }; }), {});
  assert.equal(invoked, false); assert.equal(blocked.diagnostics.reason, 'rate_limited');
  const cap = await executeTool({ name: 'capabilities', schema: { probe: z.boolean() }, run: async () => ({ ready: true }) }, { probe: false });
  assert.equal(cap.ok, true);
});
test('a timeout preserves validated search progress and its continuation', async () => {
  const out = await executeTool({ name: 'fixture', schema: { timeout_s: z.number() }, run: async () => {
    recordPartial({ items: [{ item_id: '42' }], count: 1, next_cursor: 'resume' });
    await new Promise(r => setTimeout(r, 40)); checkpoint(); return {};
  } }, { timeout_s: 0.01 });
  assert.equal(out.status, 'partial'); assert.equal(out.count, 1); assert.equal(out.data?.next_cursor, 'resume');
  assert.equal(out.diagnostics.reason, 'timeout');
  await new Promise(r => setTimeout(r, 45));
});
test('queue time counts toward the deadline and expired queued work never starts', async () => {
  let release!: () => void, ran = false;
  const first = exclusive(async () => { await new Promise<void>(r => { release = r; }); });
  await new Promise(r => setImmediate(r));
  await assert.rejects(withDeadline(0.01, () => exclusive(async () => { ran = true; })), /deadline/);
  release(); await first; await exclusive(async () => {});
  assert.equal(ran, false);
});

test('partial responses update observation ages at return time', async () => {
  const observed = new Date(Date.now() - 3000).toISOString();
  const out = await executeTool({ name: 'fixture', schema: { timeout_s: z.number() }, run: async () => {
    recordPartial({ items: [{ item_id: '42' }], freshness: { oldest_observed_at: observed, oldest_observation_age_s: 0 },
      cache: { pages: [{ observed_at: observed, observation_age_s: 0 }] } });
    await new Promise(r => setTimeout(r, 40)); checkpoint(); return {};
  } }, { timeout_s: 0.01 });
  assert.equal(out.status, 'partial');
  assert.ok(out.data!.freshness.oldest_observation_age_s >= 3);
  assert.ok(out.data!.cache.pages[0].observation_age_s >= 3);
  await new Promise(r => setTimeout(r, 45));
});
