import { describe, expect, it } from 'vitest';
import { labelResidualCandidates } from './buildTrainingLabels';
import { GroundTruthEntry } from './groundTruth';
import { CandidatePair, LedgerOrder, Settlement } from './types';

function makeSettlement(id: number, entityId: string, orderId: string): Settlement {
  return { id, entityId, orderId, amount: 100, fee: 0, tax: 0, settlementUtr: null };
}

function makeOrder(id: number, orderId: string): LedgerOrder {
  return { id, orderId, expectedAmount: 100, expectedDate: null };
}

function makeCandidate(settlement: Settlement, order: LedgerOrder): CandidatePair {
  return { settlement, order, amountDelta: 0, dateDeltaDays: null, stringSimilarity: 0.9 };
}

describe('labelResidualCandidates', () => {
  const groundTruth: GroundTruthEntry[] = [
    { entity_id: 'pay_1', order_id: 'order_A', category: 'CORRUPTED_TRUNCATED' },
    { entity_id: 'pay_2', order_id: 'order_B', category: 'CORRUPTED_SUBSTITUTED' },
  ];

  const orderA = makeOrder(1, 'order_A');
  const orderB = makeOrder(2, 'order_B');
  const orderC = makeOrder(3, 'order_C');

  const settlement1 = makeSettlement(1, 'pay_1', 'order_A_trunc'); // stored (corrupted) id, irrelevant to labeling
  const settlement2 = makeSettlement(2, 'pay_2', 'order_B_sub');
  const settlementUnknown = makeSettlement(3, 'pay_unknown', 'order_X');

  it('labels a candidate true when the order matches the settlement true order_id', () => {
    const [labeled] = labelResidualCandidates([makeCandidate(settlement1, orderA)], groundTruth);
    expect(labeled.isTrueMatch).toBe(true);
  });

  it('labels a candidate false when the order does not match the settlement true order_id', () => {
    const [labeled] = labelResidualCandidates([makeCandidate(settlement1, orderC)], groundTruth);
    expect(labeled.isTrueMatch).toBe(false);
  });

  it('labels every candidate correctly across a mixed batch', () => {
    const candidates = [
      makeCandidate(settlement1, orderA), // true
      makeCandidate(settlement1, orderB), // false (wrong order for settlement1)
      makeCandidate(settlement2, orderB), // true
      makeCandidate(settlement2, orderA), // false
    ];

    const labeled = labelResidualCandidates(candidates, groundTruth);

    expect(labeled.map((c) => c.isTrueMatch)).toEqual([true, false, true, false]);
  });

  it('labels a candidate false when the settlement has no ground-truth entry at all', () => {
    const [labeled] = labelResidualCandidates([makeCandidate(settlementUnknown, orderA)], groundTruth);
    expect(labeled.isTrueMatch).toBe(false);
  });

  it('preserves all original CandidatePair fields', () => {
    const candidate = makeCandidate(settlement1, orderA);
    const [labeled] = labelResidualCandidates([candidate], groundTruth);
    expect(labeled.settlement).toBe(settlement1);
    expect(labeled.order).toBe(orderA);
    expect(labeled.amountDelta).toBe(0);
    expect(labeled.stringSimilarity).toBe(0.9);
  });
});
