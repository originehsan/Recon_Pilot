// Stage 0: normalize an identifier by splitting off its type prefix
// ("order_", "pay_", "setl_", ...) so later stages can compare the
// meaningful part of two ids without the shared literal prefix skewing
// the comparison.

/**
 * Splits `id` at its FIRST underscore only.
 *
 *   "order_TM_5501" -> { prefix: "order", suffix: "TM_5501" }
 *   "ABC123"         -> { prefix: "",      suffix: "ABC123" }   (no underscore)
 *   ""                -> { prefix: "",      suffix: "" }
 *
 * Only the first underscore is treated as the prefix delimiter - any
 * further underscores in the id (e.g. "TM_5501") are part of the suffix,
 * not additional splits.
 */
export function stripTypePrefix(id: string): { prefix: string; suffix: string } {
  if (id === '') {
    return { prefix: '', suffix: '' };
  }

  const firstUnderscoreIndex = id.indexOf('_');

  if (firstUnderscoreIndex === -1) {
    return { prefix: '', suffix: id };
  }

  return {
    prefix: id.slice(0, firstUnderscoreIndex),
    suffix: id.slice(firstUnderscoreIndex + 1),
  };
}
