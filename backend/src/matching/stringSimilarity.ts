// Stage 4: Levenshtein-based string similarity, used to score residual
// candidates whose order_id didn't hash-match exactly (e.g. truncated or
// character-substituted ids).

/**
 * Standard Levenshtein edit distance (insertions, deletions, substitutions).
 *
 * O(len(a) * len(b)) time. Uses the rolling-two-rows technique rather than
 * the naive full matrix, so space is O(min(len(a), len(b))) instead of
 * O(len(a) * len(b)): only the previous and current DP rows are kept, and
 * `a`/`b` are swapped if needed so the row we keep is sized to the shorter
 * string.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a.length < b.length) {
    [a, b] = [b, a];
  }

  const aLen = a.length;
  const bLen = b.length;

  if (bLen === 0) {
    return aLen;
  }

  let previousRow = Array.from({ length: bLen + 1 }, (_, j) => j);
  let currentRow = new Array<number>(bLen + 1).fill(0);

  for (let i = 1; i <= aLen; i++) {
    currentRow[0] = i;
    const aChar = a[i - 1];

    for (let j = 1; j <= bLen; j++) {
      const substitutionCost = aChar === b[j - 1] ? 0 : 1;
      currentRow[j] = Math.min(
        previousRow[j] + 1, // deletion from a
        currentRow[j - 1] + 1, // insertion into a
        previousRow[j - 1] + substitutionCost, // substitution
      );
    }

    [previousRow, currentRow] = [currentRow, previousRow];
  }

  return previousRow[bLen];
}

/**
 * Normalized similarity in [0, 1]: 1 means identical, 0 means maximally
 * different relative to the longer string's length. Two empty strings are
 * treated as identical (similarity 1).
 *
 * Critical: call this ONLY on prefix-stripped suffixes (Stage 0's
 * stripTypePrefix), never on the full id including its type prefix. The
 * shared literal prefix (e.g. "order_") is identical across every id of that
 * type and carries zero discriminating information - including it would
 * artificially inflate the similarity score between two otherwise unrelated
 * ids just because they happen to be the same entity type.
 */
export function normalizedSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) {
    return 1;
  }

  const distance = levenshteinDistance(a, b);
  const similarity = 1 - distance / Math.max(a.length, b.length);

  return Math.min(1, Math.max(0, similarity));
}
