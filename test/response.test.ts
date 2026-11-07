import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { executeTool, OUTPUT_SCHEMA, resetCooldown } from '../src/response.ts';
import { GatedError, XianyuError } from '../src/errors.ts';
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
  // The identity travels in one of two shapes: the slim `{version, commit}` every answer pays for by
  // default, and the full block (`runtime_fingerprint`, dirty state, deploy verdict) behind
  // `include_meta: true`. Both name the build; only one is worth ~1.5KB on every scan row.
  const meta = (run: () => Promise<any>) => ({ name: 'fixture', schema: { include_meta: z.boolean().optional() }, run });
  const out = await executeTool(meta(async () => ({ items: [{ item_id: '1' }] })), {});
  assert.deepEqual(Object.keys(out.build).sort(), ['commit', 'version'], 'the default is the slim block');
  assert.ok(Buffer.byteLength(JSON.stringify(out.build)) <= 120, `slim build is ${Buffer.byteLength(JSON.stringify(out.build))}B`);
  assert.equal(out.count, 1); assert.equal(out.schema_version, 2);
  const full = await executeTool(meta(async () => ({ items: [{ item_id: '1' }] })), { include_meta: true });
  assert.match(full.build.runtime_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(full.build.implementation, 'typescript'); assert.ok(full.build.version);
  assert.equal(full.build.commit, out.build.commit, 'both shapes name the same build');
});
test('a failed call publishes the slim build too, and include_meta still asks for the full one', async () => {
  const meta = (run: () => Promise<any>) => ({ name: 'fixture', schema: { include_meta: z.boolean().optional() }, run });
  const slim = await executeTool(meta(async () => { throw new GatedError('RGV587'); }), {});
  assert.deepEqual(Object.keys(slim.build).sort(), ['commit', 'version'], 'a failure is the common case too');
  const full = await executeTool(meta(async () => { throw new GatedError('RGV587'); }), { include_meta: true });
  assert.match(full.build.runtime_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(full.ok, false);
});
test('capabilities publishes the full build even without include_meta', async () => {
  // The one tool an agent calls first, and the one place a stale deploy announces itself: it never
  // takes the slim shape, because a diagnostic that cannot name its own modules cannot be audited.
  const cap = await executeTool({ name: 'capabilities', schema: { probe: z.boolean().optional() }, run: async () => ({ ready: true }) }, { probe: false });
  assert.match(cap.build.runtime_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(cap.build.implementation, 'typescript');
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

test('a retry hint is never a bare "retryable: true" with no wait and no zero-wait reason', async () => {
  // The rule: `retryable: true` means the caller is told *when*; the only reasons allowed to carry a
  // zero wait are the ones where the work stopped on this call's own clock (a timeout), where waiting
  // is not what was missing. Everything else that is retryable gets a positive number.
  const { ZERO_WAIT_REASONS } = await import('../src/response.ts');
  const paths: any[] = [
    new GatedError('RGV587_ERROR::SM::被挤爆'),
    new GatedError('非法访问'),
    new GatedError('net::ERR_TUNNEL_CONNECTION_FAILED'),
    Object.assign(new Error('Call deadline reached'), { details: { reason: 'timeout', retryable: true, retry_after_s: 0 } }),
    Object.assign(new Error('bad arguments'), { details: { reason: 'invalid_arguments', retryable: true, retry_after_s: 9 } }),
    Object.assign(new Error('the query did not match'), { details: { reason: 'query_mismatch', retryable: true, retry_after_s: 30 } }),
    // A tool that says "retryable" and forgets the wait: the envelope supplies the conservative one
    // rather than publishing a hint the caller cannot act on.
    Object.assign(new Error('the site did not answer'), { details: { reason: 'unavailable', retryable: true } }),
    new Error('something unrecognised'),
  ];
  for (const thrown of paths) {
    resetCooldown();   // a throttle path arms the process cooldown, which would answer the next arm
    const out = await executeTool({ name: 'fixture', schema: {}, run: async () => { throw thrown; } }, {});
    const reason = out.diagnostics.reason;
    assert.equal(typeof reason, 'string');
    if (out.retryable) {
      assert.ok(out.retry_after_s > 0 || ZERO_WAIT_REASONS.includes(reason as any),
        `${reason} is retryable with retry_after_s ${out.retry_after_s}: no wait and not a zero-wait reason`);
    } else {
      assert.equal(out.retry_after_s, 0, `${reason} is not retryable but publishes a wait`);
    }
  }
  // The two reasons that describe the request rather than the site are never retryable, even when a
  // tool's own details claim otherwise.
  for (const reason of ['query_mismatch', 'invalid_arguments']) {
    resetCooldown();
    const out = await executeTool({ name: 'fixture', schema: {}, run: async () => { throw Object.assign(new Error('x'), { details: { reason, retryable: true, retry_after_s: 30 } }); } }, {});
    assert.equal(out.retryable, false, reason);
    assert.equal(out.retry_after_s, 0, reason);
  }
  // and the timeout path keeps its zero wait, because that is the documented exception
  resetCooldown();
  const timeout = await executeTool({ name: 'fixture', schema: {}, run: async () => { throw Object.assign(new Error('timed out'), { details: { reason: 'timeout', retryable: true, retry_after_s: 0 } }); } }, {});
  assert.deepEqual([timeout.retryable, timeout.retry_after_s, timeout.diagnostics.reason], [true, 0, 'timeout']);
  assert.ok(ZERO_WAIT_REASONS.includes('timeout'));
});

test('our own refusal is invalid_arguments even when its wording names a budget', async () => {
  // Found by the deadline_s alias test: `XianyuError('give timeout_s or deadline_s, not both')`
  // matched the message-text timeout rule before the class rule, so a call that could never work was
  // published as a retryable timeout. The class is the authoritative diagnosis here.
  const out = await executeTool({ name: 'fixture', schema: {}, run: async () => { throw new XianyuError('give timeout_s or deadline_s, not both'); } }, {});
  assert.deepEqual([out.diagnostics.reason, out.retryable, out.retry_after_s], ['invalid_arguments', false, 0]);
  // ...while a GatedError's message is still the site's own words, and still read as one.
  const gated = await executeTool({ name: 'fixture', schema: {}, run: async () => { throw new GatedError('RGV587_ERROR::SM::被挤爆'); } }, {});
  assert.deepEqual([gated.diagnostics.reason, gated.retry_after_s], ['rate_limited', 60]);
});
