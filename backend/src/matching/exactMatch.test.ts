import { describe, expect, it } from 'vitest';
import { runExactMatch } from './exactMatch';
import { LedgerOrder, Settlement } from './types';

function makeOrder(overrides: Partial<LedgerOrder> & { id: number; orderId: string; expectedAmount: number }): LedgerOrder {
  return { expectedDate: null, ...overrides };
}

function makeSettlement(
  overrides: Partial<Settlement> & { id: number; orderId: string; amount: number },
): Settlement {
  return { entityId: `pay_entity_${overrides.id}`, fee: 0, tax: 0, settlementUtr: null, ...overrides };
}

describe('runExactMatch', () => {
  // Orders:
  //   order_A1 (10000) -> clean unique match
  //   order_A2 (20000) -> two settlements both reconcile -> ambiguous duplicate
  //   order_A3 (30000) -> one settlement, wrong amount -> amount mismatch
  //   order_A4 (40000) -> no settlement references it at all -> unmatched order
  const orderA1 = makeOrder({ id: 1, orderId: 'order_A1', expectedAmount: 10000 });
  const orderA2 = makeOrder({ id: 2, orderId: 'order_A2', expectedAmount: 20000 });
  const orderA3 = makeOrder({ id: 3, orderId: 'order_A3', expectedAmount: 30000 });
  const orderA4 = makeOrder({ id: 4, orderId: 'order_A4', expectedAmount: 40000 });
  const orders = [orderA1, orderA2, orderA3, orderA4];

  // s1: reconciles exactly for A1 (10000 - 100 - 18 = 9882)
  const s1 = makeSettlement({ id: 1, orderId: 'order_A1', amount: 9882, fee: 100, tax: 18 });
  // s2 and s3: both reconcile exactly for A2 (20000 - 200 - 36 = 19764)
  const s2 = makeSettlement({ id: 2, orderId: 'order_A2', amount: 19764, fee: 200, tax: 36 });
  const s3 = makeSettlement({ id: 3, orderId: 'order_A2', amount: 19764, fee: 200, tax: 36 });
  // s4: order_id matches A3, but amount does not reconcile (29646 expected, 29000 given)
  const s4 = makeSettlement({ id: 4, orderId: 'order_A3', amount: 29000, fee: 300, tax: 54 });
  // s5: order_id doesn't exist in the orders set at all
  const s5 = makeSettlement({ id: 5, orderId: 'order_UNKNOWN', amount: 5000 });

  const settlements = [s1, s2, s3, s4, s5];
  const result = runExactMatch(settlements, orders);

  it('places the single reconciling settlement into exactMatches', () => {
    expect(result.exactMatches).toHaveLength(1);
    expect(result.exactMatches[0].settlement.id).toBe(1);
    expect(result.exactMatches[0].order.orderId).toBe('order_A1');
  });

  it('does NOT put either of two reconciling duplicates into exactMatches - both go to ambiguousExactDuplicates', () => {
    expect(result.ambiguousExactDuplicates).toHaveLength(2);
    const ids = result.ambiguousExactDuplicates.map((p) => p.settlement.id).sort();
    expect(ids).toEqual([2, 3]);
    expect(result.exactMatches.some((p) => p.settlement.id === 2 || p.settlement.id === 3)).toBe(false);
  });

  it('places a settlement whose order_id matched but amount did not reconcile into amountMismatches', () => {
    expect(result.amountMismatches).toHaveLength(1);
    expect(result.amountMismatches[0].settlement.id).toBe(4);
  });

  it('places a settlement whose order_id matched nothing into noOrderIdMatch', () => {
    expect(result.noOrderIdMatch).toHaveLength(1);
    expect(result.noOrderIdMatch[0].id).toBe(5);
  });

  it('places an order that no settlement referenced at all into unmatchedOrders', () => {
    expect(result.unmatchedOrders).toHaveLength(1);
    expect(result.unmatchedOrders[0].orderId).toBe('order_A4');
  });
});
