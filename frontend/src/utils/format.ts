/**
 * Shared, defensive number formatters for values that arrive from an API
 * response.
 *
 * Backstory: GET /api/runs/:id/exceptions used to leak MySQL's DECIMAL
 * columns straight through as JS strings (mysql2's default behavior -
 * confirmed live: priority_score came back as "40443737.60000000", typeof
 * "string", despite the API's own TS type declaring it `number`). That's
 * been fixed at the API boundary (backend/src/api/routes/runs.ts now
 * calls Number(...) before responding), but these helpers exist as a
 * second line of defense: a value declared `number` in a TS interface is
 * only ever a *compile-time* promise, never a runtime guarantee, for
 * anything that crossed a JSON API boundary. A future field, a future
 * route, or a future backend regression could reintroduce the same class
 * of bug - these helpers render a safe "—" instead of crashing the whole
 * page if that ever happens again, rather than calling a number-only
 * method (.toFixed, etc.) directly on an untrusted value.
 */

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Formats a paise integer as ₹ with Indian locale formatting.
 * Returns '—' if the value isn't actually a finite number (null,
 * undefined, a non-numeric string, NaN, etc.) rather than throwing or
 * silently rendering "₹NaN".
 */
export function formatPaise(paise: unknown): string {
  if (!isFiniteNumber(paise)) return '—';
  return '₹' + (paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Safe replacement for calling `.toFixed(digits)` directly on a value that
 * is supposed to be a number but isn't guaranteed to be one at runtime.
 * Returns '—' for anything that isn't a finite number.
 */
export function formatDecimal(value: unknown, digits: number): string {
  if (!isFiniteNumber(value)) return '—';
  return value.toFixed(digits);
}
