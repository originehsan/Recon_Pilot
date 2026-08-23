import { describe, expect, it } from 'vitest';
import { assignComponent } from './hungarianAssignment';
import { Component } from './ambiguityComponents';
import { LedgerOrder, Settlement } from './types';

function makeSettlement(id: number): Settlement {
  return {
    id,
    entityId: `pay_${id}`,
    orderId: `order_${id}`,
    amount: 100,
    fee: 0,
    tax: 0,
    settlementUtr: null,
    creditType: null,
    hasDispute: false,
    narration: null,
  };
}
function makeOrder(id: number): LedgerOrder {
  return { id, orderId: `order_${id}`, expectedAmount: 100, expectedDate: null };
}

describe('assignComponent', () => {
  it('finds the globally optimal assignment, not the greedy highest-single-edge choice', () => {
    // Classic Hungarian-vs-greedy counterexample:
    //   S1-OA = 10, S1-OB = 9
    //   S2-OA = 9,  S2-OB = 1
    // Greedy picks S1-OA (10) first, forcing S2-OB (1): total 11.
    // Optimal is S1-OB (9) + S2-OA (9): total 18.
    const s1 = makeSettlement(1);
    const s2 = makeSettlement(2);
    const oa = makeOrder(10);
    const ob = makeOrder(11);

    const component: Component = {
      settlements: [s1, s2],
      orders: [oa, ob],
      edges: [
        { settlement: s1, order: oa, fsScore: 10 },
        { settlement: s1, order: ob, fsScore: 9 },
        { settlement: s2, order: oa, fsScore: 9 },
        { settlement: s2, order: ob, fsScore: 1 },
      ],
    };

    const results = assignComponent(component);

    expect(results).toHaveLength(2);
    const bySettlementId = new Map(results.map((r) => [r.settlement.id, r]));

    expect(bySettlementId.get(1)!.order?.id).toBe(11); // S1 -> OB
    expect(bySettlementId.get(1)!.fsScore).toBe(9);
    expect(bySettlementId.get(2)!.order?.id).toBe(10); // S2 -> OA
    expect(bySettlementId.get(2)!.fsScore).toBe(9);

    const totalScore = results.reduce((sum, r) => sum + (r.fsScore ?? 0), 0);
    expect(totalScore).toBe(18); // strictly better than greedy's 11
  });

  it('assigns a settlement to a dummy (null order) when there are more settlements than orders', () => {
    const s1 = makeSettlement(1);
    const s2 = makeSettlement(2);
    const oa = makeOrder(10);

    // Only S1-OA has a qualifying edge; S2 has no candidate order at all in
    // this component.
    const component: Component = {
      settlements: [s1, s2],
      orders: [oa],
      edges: [{ settlement: s1, order: oa, fsScore: 5 }],
    };

    const results = assignComponent(component);

    expect(results).toHaveLength(2);
    const bySettlementId = new Map(results.map((r) => [r.settlement.id, r]));

    expect(bySettlementId.get(1)!.order?.id).toBe(10);
    expect(bySettlementId.get(1)!.fsScore).toBe(5);

    expect(bySettlementId.get(2)!.order).toBeNull();
    expect(bySettlementId.get(2)!.fsScore).toBeNull();
  });

  it('returns an empty array for a component with no settlements', () => {
    const component: Component = { settlements: [], orders: [makeOrder(1)], edges: [] };
    expect(assignComponent(component)).toEqual([]);
  });
});
