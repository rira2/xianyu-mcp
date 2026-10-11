/**
 * Every error this server raises on purpose. The class name is the published `error_type`, so
 * renaming one is a contract change rather than a refactor.
 *
 *   BrowserError             could not launch or drive the throwaway Chromium
 *   GatedError               goofish refused the call for this anonymous visitor
 *   ParseError               it loaded, but not in the shape we expected
 *   NavigationError          refused to navigate off goofish.com
 *   SearchUnavailableError   a GatedError: goofish declined this search on every attempt
 *   DetailUnavailableError   a GatedError: the item page would not render
 *
 * The last two are both GatedErrors and the split is the point: a search goofish declined and an
 * item page that will not paint are different facts, and a caller retries them differently.
 *
 * Anonymous search does work logged out, which is verified, but goofish decides per page load
 * whether to serve results. When it declines it never calls the search API at all -- the page
 * renders "nothing found" plus the 猜你喜欢 rail. So a declined search raises instead of returning
 * that rail, which would read as results and is not one.
 */
export class XianyuError extends Error {
  details?: Record<string, any>;
  partial?: Record<string, any>;
}
export class GatedError extends XianyuError {} export class SearchUnavailableError extends GatedError {} export class DetailUnavailableError extends GatedError {}
export class BrowserError extends XianyuError {} export class ParseError extends XianyuError {} export class NavigationError extends XianyuError {}
/** The complete set of `error_type` values this server can publish, so a caller matching on the name never sees anything else: a raw Playwright or TypeError from a path we did not guard, or a `String`/`Number`/`Object`/`Symbol` throw, is reported as `Error`. */
export const PUBLISHED_ERROR_TYPES = ['BrowserError', 'GatedError', 'SearchUnavailableError', 'DetailUnavailableError', 'ParseError', 'NavigationError', 'XianyuError', 'Error'];
/** The published envelope's two error fields. Nothing here may throw: it runs on the failure path, including on a throw whose own `message`, `toString` or `constructor` throws, and losing the error is exactly what that path must not do. */
export const describe = (e: unknown): { error_type: string; message: string } => {
  let name = '', message = '';
  try { name = String((e as any)?.constructor?.name ?? ''); message = String((e as any)?.message ?? e); } catch { try { message = Object.prototype.toString.call(e); } catch { /* nothing printable at all */ } }
  return { error_type: PUBLISHED_ERROR_TYPES.includes(name) ? name : 'Error', message: message || '(unprintable throw)' };
};
