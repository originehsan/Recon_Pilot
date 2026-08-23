// Stage 4 (continued): fill in the `stringSimilarity` field on Stage 2's
// residual candidate pairs.

import { normalizedSimilarity } from './stringSimilarity';
import { stripTypePrefix } from './normalize';
import { CandidatePair } from './types';

/**
 * Populates `stringSimilarity` on every candidate pair by comparing the
 * prefix-stripped suffixes of settlement.orderId and order.orderId (see
 * stringSimilarity.ts for why the type prefix is excluded).
 *
 * Mutates and returns the same array/objects - this stage only fills in a
 * field, it does not filter or sort. Thresholding/ranking is Fellegi-Sunter
 * scoring, a later stage out of scope here.
 */
export function scoreResidualCandidates(candidates: CandidatePair[]): CandidatePair[] {
  for (const candidate of candidates) {
    const settlementSuffix = stripTypePrefix(candidate.settlement.orderId).suffix;
    const orderSuffix = stripTypePrefix(candidate.order.orderId).suffix;
    candidate.stringSimilarity = normalizedSimilarity(settlementSuffix, orderSuffix);
  }

  return candidates;
}
