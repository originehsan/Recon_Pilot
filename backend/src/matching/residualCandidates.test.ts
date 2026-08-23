import { describe, expect, it } from 'vitest';
import { generateResidualCandidates } from './residualCandidates';
import { LedgerOrder, Settlement } from './types';

describe('generateResidualCandidates', () => {
  const settlements: Settlement[] = [
    { id: 1, entityId: 'pay_1', orderId: 'order_TRUNC1', amount: 9882, fee: 100, tax: 18, settlementUtr: null },
    { id: 2, entityId: 'pay_2', orderId: 'order_TRUNC2', amount: 5000, fee: 50, tax: 9, settlementUtr: null },
  ];

  const orders: LedgerOrder[] = [
    { id: 10, orderId: 'order_TRUNCATED1', expectedAmount: 10000, expectedDate: null },
    { id: 11, orderId: 'order_TRUNCATED2', expectedAmount: 20000, expectedDate: null },
    { id: 12, orderId: 'order_TRUNCATED3', expectedAmount: 30000, expectedDate: null },
  ];

  const result = generateResidualCandidates(settlements, orders);

  it('produces the full cross product: settlements.length * orders.length', () => {
    expect(result).toHaveLength(settlements.length * orders.length);
  });

  it('computes amountDelta correctly for a known pair', () => {
    // settlement 1 vs order 10: 9882 - (10000 - 100 - 18) = 9882 - 9882 = 0
    const pair = result.find((p) => p.settlement.id === 1 && p.order.id === 10);
    expect(pair).toBeDefined();
    expect(pair!.amountDelta).toBe(0);

    // settlement 2 vs order 11: 5000 - (20000 - 50 - 9) = 5000 - 19941 = -14941
    const pair2 = result.find((p) => p.settlement.id === 2 && p.order.id === 11);
    expect(pair2).toBeDefined();
    expect(pair2!.amountDelta).toBe(5000 - (20000 - 50 - 9));
  });

  it('leaves dateDeltaDays and stringSimilarity unset (null) at this stage', () => {
    for (const pair of result) {
      expect(pair.dateDeltaDays).toBeNull();
      expect(pair.stringSimilarity).toBeNull();
    }
  });

  it('returns an empty array when either residual set is empty', () => {
    expect(generateResidualCandidates([], orders)).toEqual([]);
    expect(generateResidualCandidates(settlements, [])).toEqual([]);
  });
});
