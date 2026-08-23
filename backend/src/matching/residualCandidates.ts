// Stage 2: build the full candidate set between the settlements Stage 1
// couldn't hash-match at all and the orders Stage 1 couldn't attach any
// settlement to.

import { CandidatePair, LedgerOrder, Settlement } from './types';

/**
 * Takes ONLY the residual sets from Stage 1 - `noOrderIdMatch` settlements
 * and `unmatchedOrders` orders - never the full original dataset, and
 * returns every (settlement, order) pair between them with amountDelta
 * computed.
 *
 * No filtering, thresholding, or scoring happens here; that's Fellegi-Sunter
 * scoring, a later stage out of scope for this module.
 *
 * Blocking/indexing is intentionally skipped: the residual sets are expected
 * to be small (tens of records, not the full ~180-row dataset), so a full
 * O(n * m) comparison here is trivial - at most a few hundred pairs. Any
 * blocking key (e.g. bucketing by amount range or by a prefix of order_id)
 * risks silently dropping a true match - exactly the corrupted-order-id
 * cases this stage exists to recover, where the very thing a blocking key
 * would key on is the part that's been corrupted. A missed true match is
 * strictly worse than the CPU cost this would save.
 */
export function generateResidualCandidates(
  unmatchedSettlements: Settlement[],
  unmatchedOrders: LedgerOrder[],
): CandidatePair[] {
  const candidates: CandidatePair[] = [];

  for (const settlement of unmatchedSettlements) {
    for (const order of unmatchedOrders) {
      candidates.push({
        settlement,
        order,
        amountDelta: settlement.amount - (order.expectedAmount - settlement.fee - settlement.tax),
        // The Settlement interface carries no date field in the current
        // schema projection (see types.ts), so there is no settlement-side
        // date to diff against order.expectedDate. Rather than fabricate one
        // (e.g. from an ingestion timestamp, which reflects when the row was
        // ingested, not when the payment happened), this is left null and
        // documented as a signal that isn't currently available.
        dateDeltaDays: null,
        // Populated in Stage 4 (scoreResidualCandidates), not here.
        stringSimilarity: null,
      });
    }
  }

  return candidates;
}
