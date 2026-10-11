/** A deadline travels through the DOM queue and every browser operation. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { XianyuError } from './errors.ts';
type Call = { deadline: number; expired: boolean; partial: any | null };
const calls = new AsyncLocalStorage<Call>();
export const deadlineError = () => Object.assign(new XianyuError('Call deadline reached; no additional work will be started.'), { details: { reason: 'timeout', retryable: true, retry_after_s: 0 } });
export const checkpoint = () => { const c = calls.getStore(); if (c && (c.expired || Date.now() >= c.deadline)) throw deadlineError(); };
export const remainingMs = (fallback: number): number => { checkpoint(); const c = calls.getStore(); return c ? Math.max(1, Math.min(fallback, c.deadline - Date.now())) : fallback; };
export const recordPartial = (partial: any) => { const c = calls.getStore(); if (c) c.partial = structuredClone(partial); };
export const withDeadline = async <T>(seconds: number, fn: () => Promise<T>): Promise<T> => {
  const call: Call = { deadline: Date.now() + seconds * 1000, expired: false, partial: null };
  return calls.run(call, async () => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      call.expired = true;
      const e = deadlineError();
      if (call.partial) Object.assign(e, { partial: call.partial });
      reject(e);
    }, seconds * 1000); });
    // The underlying DOM promise retains its lock until it stops; it never releases the
    // shared page just because its caller timed out. Browser primitives check this context.
    try { return await Promise.race([Promise.resolve().then(fn), timeout]); }
    catch (e) { if (call.partial && e instanceof Error && !(e as any).partial) Object.assign(e, { partial: call.partial }); throw e; }
    finally { clearTimeout(timer!); }
  });
};
