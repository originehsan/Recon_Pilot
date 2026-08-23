import { describe, expect, it } from 'vitest';
import { detectSplitPayments } from './splitPaymentDetector';
import { LedgerOrder, Settlement } from './types';

function makeSettlement(id: number, orderId: string, amount: number): Settlement {
  return { id, entityId: `pay_${id}`, orderId, amount, fee: 0, tax: 0, settlementUtr: null };
}

function makeOrder(id: number, orderId: string, expectedAmount: number): LedgerOrder {
  return { id, orderId, expectedAmount, expectedDate: null };
}

describe('detectSplitPayments', () => {
  it('resolves a clean 2-way split uniquely', () => {
    const order = makeOrder(1, 'order_O1', 1000);
    const a = makeSettlement(1, 'order_O1', 400);
    const b = makeSettlement(2, 'order_O1', 600);

    const [result] = detectSplitPayments([
      { settlement: a, order },
      { settlement: b, order },
    ]);

    expect(result.status).toBe('UNIQUE_SOLUTION');
    expect(result.matchedSettlements).toHaveLength(2);
    expect(result.matchedSettlements!.map((s) => s.id).sort()).toEqual([1, 2]);
  });

  it('resolves a clean 3-way split uniquely', () => {
    const order = makeOrder(2, 'order_O2', 900);
    const a = makeSettlement(3, 'order_O2', 300);
    const b = makeSettlement(4, 'order_O2', 300);
    const c = makeSettlement(5, 'order_O2', 300);

    const [result] = detectSplitPayments([
      { settlement: a, order },
      { settlement: b, order },
      { settlement: c, order },
    ]);

    expect(result.status).toBe('UNIQUE_SOLUTION');
    expect(result.matchedSettlements).toHaveLength(3);
    expect(result.matchedSettlements!.map((s) => s.id).sort()).toEqual([3, 4, 5]);
  });

  it('skips an order with only 1 mismatched settlement instead of falsely flagging it', () => {
    const order = makeOrder(3, 'order_O3', 500);
    const lone = makeSettlement(6, 'order_O3', 499);

    const results = detectSplitPayments([{ settlement: lone, order }]);

    expect(results).toHaveLength(0);
  });

  it('reports AMBIGUOUS, not a guess, when two equally-valid subsets exist', () => {
    // A+B = 1000 and C+D = 1000 - both valid, neither should be picked.
    const order = makeOrder(4, 'order_O4', 1000);
    const a = makeSettlement(7, 'order_O4', 400);
    const b = makeSettlement(8, 'order_O4', 600);
    const c = makeSettlement(9, 'order_O4', 250);
    const d = makeSettlement(10, 'order_O4', 750);

    const [result] = detectSplitPayments([
      { settlement: a, order },
      { settlement: b, order },
      { settlement: c, order },
      { settlement: d, order },
    ]);

    expect(result.status).toBe('AMBIGUOUS');
    expect(result.matchedSettlements).toBeNull();
    expect(result.allValidSubsets).toHaveLength(2);

    const subsetIdSets = result.allValidSubsets.map((subset) => subset.map((s) => s.id).sort().join(','));
    expect(subsetIdSets.sort()).toEqual(['10,9', '7,8']);
  });

  it('reports NO_SOLUTION when no subset of the mismatched settlements reconciles', () => {
    const order = makeOrder(5, 'order_O5', 1000);
    const a = makeSettlement(11, 'order_O5', 300);
    const b = makeSettlement(12, 'order_O5', 300);

    const [result] = detectSplitPayments([
      { settlement: a, order },
      { settlement: b, order },
    ]);

    expect(result.status).toBe('NO_SOLUTION');
    expect(result.matchedSettlements).toBeNull();
    expect(result.allValidSubsets).toHaveLength(0);
  });
});
