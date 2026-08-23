import { describe, expect, it } from 'vitest';
import { findAmbiguityComponents } from './ambiguityComponents';
import { CandidatePair, LedgerOrder, Settlement } from './types';

function makeSettlement(id: number): Settlement {
  return { id, entityId: `pay_${id}`, orderId: `order_${id}`, amount: 100, fee: 0, tax: 0, settlementUtr: null };
}
function makeOrder(id: number): LedgerOrder {
  return { id, orderId: `order_${id}`, expectedAmount: 100, expectedDate: null };
}
function makeCandidate(settlement: Settlement, order: LedgerOrder, fsScore: number): CandidatePair & { fsScore: number } {
  return { settlement, order, amountDelta: 0, dateDeltaDays: null, stringSimilarity: 0.9, fsScore };
}

describe('findAmbiguityComponents', () => {
  it('finds two clearly separate components and excludes candidates below the threshold', () => {
    const s1 = makeSettlement(1);
    const s2 = makeSettlement(2);
    const s3 = makeSettlement(3);
    const s4 = makeSettlement(4); // only connected via a below-threshold edge - should be excluded entirely
    const o1 = makeOrder(1);
    const o2 = makeOrder(2);
    const o3 = makeOrder(3);
    const o4 = makeOrder(4);

    const lowerThreshold = 1.0;

    const candidates = [
      // Component A: s1, s2, o1 (s1-o1 and s2-o1 both qualify)
      makeCandidate(s1, o1, 2.0),
      makeCandidate(s2, o1, 1.5),
      // Component B: s3, o2, o3 (s3-o2 and s3-o3 both qualify)
      makeCandidate(s3, o2, 3.0),
      makeCandidate(s3, o3, 1.2),
      // Below threshold - s4/o4 should not appear in any component
      makeCandidate(s4, o4, 0.5),
    ];

    const components = findAmbiguityComponents(candidates, lowerThreshold);

    expect(components).toHaveLength(2);

    const byHasSettlement1 = components.find((c) => c.settlements.some((s) => s.id === 1))!;
    expect(byHasSettlement1.settlements.map((s) => s.id).sort()).toEqual([1, 2]);
    expect(byHasSettlement1.orders.map((o) => o.id)).toEqual([1]);
    expect(byHasSettlement1.edges).toHaveLength(2);

    const byHasSettlement3 = components.find((c) => c.settlements.some((s) => s.id === 3))!;
    expect(byHasSettlement3.settlements.map((s) => s.id)).toEqual([3]);
    expect(byHasSettlement3.orders.map((o) => o.id).sort()).toEqual([2, 3]);
    expect(byHasSettlement3.edges).toHaveLength(2);

    const allNodeIds = components.flatMap((c) => [
      ...c.settlements.map((s) => `s${s.id}`),
      ...c.orders.map((o) => `o${o.id}`),
    ]);
    expect(allNodeIds).not.toContain('s4');
    expect(allNodeIds).not.toContain('o4');
  });

  it('includes an edge whose score is exactly equal to the threshold (inclusive >=)', () => {
    const s1 = makeSettlement(1);
    const o1 = makeOrder(1);
    const lowerThreshold = 2.0;

    const components = findAmbiguityComponents([makeCandidate(s1, o1, 2.0)], lowerThreshold);

    expect(components).toHaveLength(1);
    expect(components[0].edges).toHaveLength(1);
    expect(components[0].edges[0].fsScore).toBe(2.0);
  });

  it('excludes an edge just below the threshold', () => {
    const s1 = makeSettlement(1);
    const o1 = makeOrder(1);
    const lowerThreshold = 2.0;

    const components = findAmbiguityComponents([makeCandidate(s1, o1, 1.999999)], lowerThreshold);

    expect(components).toHaveLength(0);
  });

  it('returns an empty array for an empty candidate list', () => {
    expect(findAmbiguityComponents([], 0)).toEqual([]);
  });
});
