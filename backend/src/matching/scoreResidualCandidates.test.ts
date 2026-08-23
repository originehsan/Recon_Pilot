import { describe, expect, it } from 'vitest';
import { scoreResidualCandidates } from './scoreResidualCandidates';
import { CandidatePair, LedgerOrder, Settlement } from './types';

function makeCandidate(settlementOrderId: string, orderOrderId: string): CandidatePair {
  const settlement: Settlement = {
    id: 1,
    entityId: 'pay_1',
    orderId: settlementOrderId,
    amount: 100,
    fee: 0,
    tax: 0,
    settlementUtr: null,
  };
  const order: LedgerOrder = { id: 1, orderId: orderOrderId, expectedAmount: 100, expectedDate: null };

  return { settlement, order, amountDelta: 0, dateDeltaDays: null, stringSimilarity: null };
}

describe('scoreResidualCandidates', () => {
  it('scores similarity on the prefix-stripped suffixes, not the full id', () => {
    // Full ids share nothing obviously in common except the "order_" prefix;
    // the suffixes ("TM5501" vs "TM55") are a realistic truncation.
    const candidates = [makeCandidate('order_TM5501', 'order_TM55')];

    const scored = scoreResidualCandidates(candidates);

    expect(scored[0].stringSimilarity).not.toBeNull();
    expect(scored[0].stringSimilarity).toBeCloseTo(1 - 2 / 6, 10);
  });

  it('mutates and returns the same array without touching amountDelta or dateDeltaDays', () => {
    const candidates = [makeCandidate('order_ABC', 'order_ABC')];
    candidates[0].amountDelta = 42;
    candidates[0].dateDeltaDays = 3;

    const scored = scoreResidualCandidates(candidates);

    expect(scored).toBe(candidates);
    expect(scored[0].amountDelta).toBe(42);
    expect(scored[0].dateDeltaDays).toBe(3);
    expect(scored[0].stringSimilarity).toBe(1);
  });

  it('handles an empty input array', () => {
    expect(scoreResidualCandidates([])).toEqual([]);
  });
});
