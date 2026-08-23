// Step 1: label every Stage 2 residual candidate pair as a true match or not,
// using ground truth. This produces the full labeled set used both for
// Fellegi-Sunter parameter estimation (Step 2) and later end-to-end
// verification - it is not sampled or filtered.

import { CandidatePair } from './types';
import { GroundTruthEntry } from './groundTruth';

export interface LabeledCandidate extends CandidatePair {
  isTrueMatch: boolean;
}

/**
 * `groundTruth[i].order_id` already holds the canonical/true order_id for
 * that settlement (see groundTruth.ts) - keyed here by entity_id, which is
 * how settlements are identified in ground truth.
 */
export function labelResidualCandidates(
  candidates: CandidatePair[],
  groundTruth: GroundTruthEntry[],
): LabeledCandidate[] {
  const trueOrderIdByEntityId = new Map<string, string>();
  for (const entry of groundTruth) {
    if (entry.entity_id !== null) {
      trueOrderIdByEntityId.set(entry.entity_id, entry.order_id);
    }
  }

  return candidates.map((candidate) => {
    const trueOrderId = trueOrderIdByEntityId.get(candidate.settlement.entityId);
    const isTrueMatch = trueOrderId !== undefined && candidate.order.orderId === trueOrderId;
    return { ...candidate, isTrueMatch };
  });
}
