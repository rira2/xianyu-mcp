/** One result contract for every tool, including failures and partial searches. */
import { z } from 'zod';
import { buildBlock } from './build.ts';
import { describe, XianyuError } from './errors.ts';
import { withDeadline } from './runtime.ts';

export const OUTPUT_SCHEMA = {
  ok: z.boolean(), status: z.enum(['success', 'empty', 'partial', 'error']),
  count: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()).nullable(), error_type: z.string().nullable(), message: z.string().nullable(),
  retryable: z.boolean(), retry_after_s: z.number().nonnegative(),
  diagnostics: z.record(z.string(), z.unknown()), build: z.record(z.string(), z.unknown()),
  schema_version: z.number().int(), elapsed_ms: z.number().nonnegative(),
};
export const failureDetails = (e: unknown): Record<string, any> => {
  const { error_type, message } = describe(e);
  let explicit: any;
  try { explicit = (e as any)?.details; } catch { /* a thrown getter cannot erase the failure */ }
  if (explicit && typeof explicit === 'object') { try { return structuredClone(explicit); } catch { /* opaque diagnostic values do not erase errors */ } }
  const text = message.toLowerCase();
  if (/rgv587|被挤爆|too many requests|rate.?limit/.test(text)) return { reason: 'rate_limited', retryable: true, retry_after_s: 60 };
  if (/非法访问|正常浏览器|risk.control|illegal_access/.test(text)) return { reason: 'risk_control', retryable: true, retry_after_s: 60 };
  if (/err_tunnel|connect.*403|err_address|err_name|connection|network|could not load/.test(text)) return { reason: 'network', retryable: true, retry_after_s: 5 };
  if (/timeout|timed out|deadline|time budget/.test(text)) return { reason: 'timeout', retryable: true, retry_after_s: 0 };
  if (error_type === 'ParseError') return { reason: 'unexpected_payload', retryable: false, retry_after_s: 0 };
  if (error_type === 'NavigationError' || error_type === 'XianyuError') return { reason: 'invalid_arguments', retryable: false, retry_after_s: 0 };
  return { reason: 'unavailable', retryable: true, retry_after_s: 5 };
};
let cooldownUntil = 0, throttleEvents = 0;
export const resetCooldown = () => { cooldownUntil = throttleEvents = 0; };
export const cooldown = () => ({ retry_after_s: Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)),
  scope: 'this_server_process', note: 'Goofish may throttle a shared public IP. This process cannot measure other clients on that IP.' });
/** Arm the process cooldown from a throttle the site itself named. Exported because `search_batch`
 *  sees one per row, below this envelope: its `stop_reason` is the batch's `cooldown`, so the site's
 *  own word (`rate_limited` / `risk_control`) would otherwise never reach the process. */
export const observeThrottle = (reason: string) => {
  if (!['rate_limited', 'risk_control'].includes(reason)) return;
  if (cooldown().retry_after_s) return;
  throttleEvents++;
  cooldownUntil = Math.max(cooldownUntil, Date.now() + Math.min(300, 60 * 2 ** Math.max(0, throttleEvents - 1)) * 1000);
};
const refreshObservationAge = (data: Record<string, any>) => {
  const stamp = Date.parse(data.freshness?.oldest_observed_at ?? '');
  if (Number.isFinite(stamp)) data.freshness.oldest_observation_age_s = Math.max(0, (Date.now() - stamp) / 1000);
  for (const page of data.cache?.pages ?? []) {
    const observed = Date.parse(page.observed_at ?? '');
    if (Number.isFinite(observed)) page.observation_age_s = Math.max(0, (Date.now() - observed) / 1000);
  }
};

type Definition = { name: string; schema: z.ZodRawShape; run: (args: any) => Promise<Record<string, any>>;
  /** The envelope's fallback budget in seconds when neither the call nor `args.timeout_s` set one.
   *  A tool whose own default is longer than `search_items`' 90s names it here, so the schema can
   *  leave `timeout_s` optional and let `XIANYU_CALL_TIMEOUT_S` through. */
  default_timeout_s?: number };
export const executeTool = async (tool: Definition, input: unknown) => {
  const started = Date.now(), build = buildBlock();
  const common = { schema_version: 2, build };
  let args: any;
  try {
    const parsed = z.strictObject(tool.schema).safeParse(input);
    if (!parsed.success) throw new XianyuError(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    args = parsed.data;
    const wait = cooldown().retry_after_s;
    if (wait && !(tool.name === 'capabilities' && args.probe === false)) {
      throw Object.assign(new XianyuError(`Goofish cooldown active; retry in ${wait}s.`), { details: { reason: 'rate_limited', retryable: true, retry_after_s: wait, cooldown: cooldown() } });
    }
    const searchDefault = tool.name === 'search_items' && args.detail > 0 ? Math.min(600, 60 + args.detail * 10) : 90;
    const configuredSearch = Number(process.env.XIANYU_SEARCH_BUDGET_S);
    const fallback = tool.default_timeout_s ?? (tool.name === 'search_items' && Number.isInteger(configuredSearch) && configuredSearch >= 5 ? Math.min(600, configuredSearch) : searchDefault);
    const envBudget = Number(process.env.XIANYU_CALL_TIMEOUT_S);
    const timeout = args.timeout_s ?? (Number.isInteger(envBudget) && envBudget >= 1 ? Math.min(600, envBudget) : fallback);
    const data = await withDeadline(Math.max(0.001, timeout - (Date.now() - started) / 1000), () => tool.run(args));
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) throw Object.assign(new XianyuError('Tool returned an empty or invalid response.'), { details: { reason: 'unexpected_payload', retryable: false, retry_after_s: 0 } });
    try { JSON.stringify(data); } catch { throw Object.assign(new XianyuError('Tool returned a response that cannot be serialized.'), { details: { reason: 'unexpected_payload', retryable: false, retry_after_s: 0 } }); }
    const items = Array.isArray(data.items) ? data.items : [];
    const count = Array.isArray(data.items) ? items.length : Number.isSafeInteger(data.count) && data.count >= 0 ? data.count : 0;
    const status = data.partial ? 'partial' : Array.isArray(data.items) && !items.length ? 'empty' : 'success';
    refreshObservationAge(data);
    if (data.partial) observeThrottle(data.stop_reason);
    if (data.partial && cooldown().retry_after_s) data.retry_after_s = cooldown().retry_after_s;
    return { ...common, ok: true, status, count, data, error_type: null, message: null,
      retryable: Boolean(data.partial), retry_after_s: data.retry_after_s ?? 0, diagnostics: { ...(data.diagnostics ?? {}), cooldown: cooldown() }, elapsed_ms: Date.now() - started };
  } catch (e) {
    const details = failureDetails(e);
    if (details.reason === 'rate_limited' || details.reason === 'risk_control') {
      observeThrottle(details.reason);
      details.retry_after_s = cooldown().retry_after_s;
    }
    let partial: any;
    try { partial = (e as any)?.partial; } catch { /* preserve an opaque failure */ }
    // Two shapes reach this arm: a single search's page-level partial (`items`) and a batch's
    // `queries[]` snapshot. A batch is recognised by its `queries` array and published as the call's
    // data whole -- completed rows, totals, count and stop_reason -- instead of being forced into the
    // single-search shape, which is how a deadline tear-down used to lose the rows it had paid for.
    if (partial && (Array.isArray(partial.queries) || Array.isArray(partial.items))) {
      const batch = Array.isArray(partial.queries);
      // A batch partial is self-describing: it already carries `stop_reason`, `retry_after_s`, `count`
      // and its totals, so the deadline's own details must not overwrite what the rows recorded (a
      // partial that latched a throttle would lose the wait). A single-search page partial carries
      // none of those, so the failure details fill them in as they always have.
      const data = batch
        ? { ...partial, partial: true as const }
        : { ...partial, partial: true as const, stop_reason: details.reason, retry_after_s: details.retry_after_s };
      refreshObservationAge(data);
      const count = batch
        ? Number.isSafeInteger(data.count) && data.count >= 0 ? data.count : 0
        : data.items.length;
      const retryAfter = batch ? Number(data.retry_after_s) || 0 : details.retry_after_s;
      return { ...common, ok: true, status: 'partial' as const, count, data,
        error_type: null, message: null, retryable: true, retry_after_s: retryAfter, diagnostics: details, elapsed_ms: Date.now() - started };
    }
    return { ...common, ok: false, status: 'error' as const, count: 0, data: null, ...describe(e),
      retryable: Boolean(details.retryable), retry_after_s: details.retry_after_s ?? 0, diagnostics: details, elapsed_ms: Date.now() - started };
  }
};
