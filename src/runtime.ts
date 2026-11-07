/** A deadline travels through the DOM queue and every browser operation. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { XianyuError } from './errors.ts';
type Call = { deadline: number; expired: boolean; partial: any | null; batchPartial: any | null };
const calls = new AsyncLocalStorage<Call>();
export const deadlineError = () => Object.assign(new XianyuError('Call deadline reached; no additional work will be started.'), { details: { reason: 'timeout', retryable: true, retry_after_s: 0 } });
export const checkpoint = () => { const c = calls.getStore(); if (c && (c.expired || Date.now() >= c.deadline)) throw deadlineError(); };
export const remainingMs = (fallback: number): number => { checkpoint(); const c = calls.getStore(); return c ? Math.max(1, Math.min(fallback, c.deadline - Date.now())) : fallback; };
/** The call's remaining budget in ms, or `Infinity` when this call has no deadline. Unlike
 *  `remainingMs`, it never throws: work that is deciding whether to *start* -- not work already in
 *  flight -- has to read an expired clock as zero, because the decision belongs to the fallback. */
export const remainingBudgetMs = (): number => { try { return remainingMs(Number.POSITIVE_INFINITY); } catch { return 0; } };
export const recordPartial = (partial: any) => { const c = calls.getStore(); if (c) c.partial = structuredClone(partial); };
/** The batch's own partial, kept in a second slot because a batch runs `search_items` inside the same
 *  call and every page that query validates overwrites `partial` with a single-search shape. The
 *  batch slot is what a tear-down publishes, so completed rows survive a query that never returns. */
export const recordBatchPartial = (partial: any) => { const c = calls.getStore(); if (c) c.batchPartial = structuredClone(partial); };
const partialFor = (call: Call): any => call.batchPartial ?? call.partial;
export const withDeadline = async <T>(seconds: number, fn: () => Promise<T>): Promise<T> => {
  const call: Call = { deadline: Date.now() + seconds * 1000, expired: false, partial: null, batchPartial: null };
  return calls.run(call, async () => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      call.expired = true;
      const e = deadlineError();
      const kept = partialFor(call);
      if (kept) Object.assign(e, { partial: kept });
      reject(e);
    }, seconds * 1000); });
    // The underlying DOM promise retains its lock until it stops; it never releases the
    // shared page just because its caller timed out. Browser primitives check this context.
    try { return await Promise.race([Promise.resolve().then(fn), timeout]); }
    catch (e) { const kept = partialFor(call); if (kept && e instanceof Error && !(e as any).partial) Object.assign(e, { partial: kept }); throw e; }
    finally { clearTimeout(timer!); }
  });
};
