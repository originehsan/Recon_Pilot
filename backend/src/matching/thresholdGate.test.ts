import { describe, expect, it } from 'vitest';
import { routeAllCases } from './thresholdGate';
import { LedgerOrder, Settlement } from './types';
import { SplitPaymentResult } from './splitPaymentDetector';
import { AssignmentResult } from './hungarianAssignment';
import { Thresholds } from './calibrateThresholds';

function makeSettlement(id: number, orderId?: string): Settlement {
  return { id, entityId: `pay_${id}`, orderId: orderId ?? `order_${id}`, amount: 100, fee: 0, tax: 0, settlementUtr: null };
}
function makeOrder(id: number, orderId?: string): LedgerOrder {
  return { id, orderId: orderId ?? `order_${id}`, expectedAmount: 100, expectedDate: null };
}

const thresholds: Thresholds = { upper: 3, lower: -1 };

describe('routeAllCases', () => {
  it('rule 1: routes every exact match to auto_resolve with no FS score', () => {
    const s = makeSettlement(1);
    const o = makeOrder(1);

    const result = routeAllCases([{ settlement: s, order: o }], [], [], [], thresholds);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      caseType: 'exact_match',
      order: o,
      fsScore: null,
      route: 'auto_resolve',
      reasonCode: 'exact_id_and_amount_match',
    });
    expect(result[0].settlements).toEqual([s]);
  });

  it('rule 2: groups ambiguous duplicates on the same order into a single case', () => {
    const o = makeOrder(2);
    const s1 = makeSettlement(1, o.orderId);
    const s2 = makeSettlement(2, o.orderId);

    const result = routeAllCases(
      [],
      [
        { settlement: s1, order: o },
        { settlement: s2, order: o },
      ],
      [],
      [],
      thresholds,
    );

    expect(result).toHaveLength(1);
    expect(result[0].caseType).toBe('ambiguous_duplicate');
    expect(result[0].route).toBe('ai_investigation');
    expect(result[0].reasonCode).toBe('multiple_settlements_same_order_same_amount_no_discriminating_signal');
    expect(result[0].settlements.map((s) => s.id).sort()).toEqual([1, 2]);
  });

  it('rule 2: two different orders each with duplicates produce two separate cases', () => {
    const oA = makeOrder(1);
    const oB = makeOrder(2);
    const pairs = [
      { settlement: makeSettlement(1, oA.orderId), order: oA },
      { settlement: makeSettlement(2, oA.orderId), order: oA },
      { settlement: makeSettlement(3, oB.orderId), order: oB },
      { settlement: makeSettlement(4, oB.orderId), order: oB },
    ];

    const result = routeAllCases([], pairs, [], [], thresholds);

    expect(result).toHaveLength(2);
  });

  it('rule 3: routes a UNIQUE_SOLUTION split payment to auto_resolve with its matched settlements', () => {
    const o = makeOrder(3);
    const s1 = makeSettlement(1, o.orderId);
    const s2 = makeSettlement(2, o.orderId);
    const splitResult: SplitPaymentResult = {
      orderId: o.orderId,
      order: o,
      status: 'UNIQUE_SOLUTION',
      matchedSettlements: [s1, s2],
      allValidSubsets: [[s1, s2]],
    };

    const result = routeAllCases([], [], [splitResult], [], thresholds);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      caseType: 'split_payment',
      order: o,
      fsScore: null,
      route: 'auto_resolve',
      reasonCode: 'unique_subset_sum_match',
    });
    expect(result[0].settlements).toEqual([s1, s2]);
  });

  it('rule 4: routes AMBIGUOUS and NO_SOLUTION split payments to ai_investigation', () => {
    const o = makeOrder(4);
    const s1 = makeSettlement(1, o.orderId);
    const s2 = makeSettlement(2, o.orderId);

    const ambiguous: SplitPaymentResult = {
      orderId: o.orderId,
      order: o,
      status: 'AMBIGUOUS',
      matchedSettlements: null,
      allValidSubsets: [[s1], [s2]],
    };
    const noSolution: SplitPaymentResult = {
      orderId: o.orderId,
      order: o,
      status: 'NO_SOLUTION',
      matchedSettlements: null,
      allValidSubsets: [],
    };

    const result = routeAllCases([], [], [ambiguous, noSolution], [], thresholds);

    expect(result).toHaveLength(2);

    expect(result[0]).toMatchObject({
      caseType: 'split_payment_ambiguous',
      route: 'ai_investigation',
      reasonCode: 'multiple_valid_subset_sums',
    });
    expect(result[0].settlements.map((s) => s.id).sort()).toEqual([1, 2]);

    expect(result[1]).toMatchObject({
      caseType: 'split_payment_ambiguous',
      route: 'ai_investigation',
      reasonCode: 'no_subset_sum_reconciles',
    });
    expect(result[1].settlements).toEqual([]);
  });

  it('rule 5: routes Hungarian assignments above upper to auto_resolve, and in [lower, upper) to human_review', () => {
    const oHigh = makeOrder(5);
    const sHigh = makeSettlement(5, oHigh.orderId);
    const oMid = makeOrder(6);
    const sMid = makeSettlement(6, oMid.orderId);

    const hungarianResults: AssignmentResult[] = [
      { settlement: sHigh, order: oHigh, fsScore: 4 }, // >= upper(3) -> auto_resolve
      { settlement: sMid, order: oMid, fsScore: 0 }, // in [lower(-1), upper(3)) -> human_review
    ];

    const result = routeAllCases([], [], [], hungarianResults, thresholds);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      caseType: 'residual_match',
      route: 'auto_resolve',
      reasonCode: 'fs_score_above_calibrated_threshold',
      fsScore: 4,
    });
    expect(result[1]).toMatchObject({
      caseType: 'residual_match',
      route: 'human_review',
      reasonCode: 'fs_score_in_review_band',
      fsScore: 0,
    });
  });

  it('rule 5: treats a score exactly at upper as auto_resolve (inclusive)', () => {
    const o = makeOrder(7);
    const s = makeSettlement(7, o.orderId);
    const hungarianResults: AssignmentResult[] = [{ settlement: s, order: o, fsScore: 3 }];

    const result = routeAllCases([], [], [], hungarianResults, thresholds);

    expect(result[0].route).toBe('auto_resolve');
  });

  it('rule 5: throws if a non-dummy Hungarian result scores below the lower threshold', () => {
    const o = makeOrder(8);
    const s = makeSettlement(8, o.orderId);
    const hungarianResults: AssignmentResult[] = [{ settlement: s, order: o, fsScore: -5 }];

    expect(() => routeAllCases([], [], [], hungarianResults, thresholds)).toThrow();
  });

  it('rule 6: routes a dummy-assigned (null order) Hungarian result to ai_investigation as residual_no_match', () => {
    const s = makeSettlement(9);
    const hungarianResults: AssignmentResult[] = [{ settlement: s, order: null, fsScore: null }];

    const result = routeAllCases([], [], [], hungarianResults, thresholds);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      caseType: 'residual_no_match',
      order: null,
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'no_viable_candidate_in_component',
    });
    expect(result[0].settlements).toEqual([s]);
  });

  it('keeps residual_match (Rule 5, order found) and residual_no_match (Rule 6, dummy) as distinct caseTypes', () => {
    const matchedOrder = makeOrder(10);
    const matchedSettlement = makeSettlement(10, matchedOrder.orderId);
    const dummySettlement = makeSettlement(11);

    const hungarianResults: AssignmentResult[] = [
      { settlement: matchedSettlement, order: matchedOrder, fsScore: 4 }, // Rule 5 -> residual_match
      { settlement: dummySettlement, order: null, fsScore: null }, // Rule 6 -> residual_no_match
    ];

    const result = routeAllCases([], [], [], hungarianResults, thresholds);

    expect(result).toHaveLength(2);
    const byId = new Map(result.map((c) => [c.settlements[0].id, c]));
    expect(byId.get(10)!.caseType).toBe('residual_match');
    expect(byId.get(10)!.route).toBe('auto_resolve');
    expect(byId.get(11)!.caseType).toBe('residual_no_match');
    expect(byId.get(11)!.route).toBe('ai_investigation');
  });

  it('combines all rule types into one routed-case list', () => {
    const exactOrder = makeOrder(100);
    const exactSettlement = makeSettlement(100, exactOrder.orderId);
    const dummySettlement = makeSettlement(200);

    const result = routeAllCases(
      [{ settlement: exactSettlement, order: exactOrder }],
      [],
      [],
      [{ settlement: dummySettlement, order: null, fsScore: null }],
      thresholds,
    );

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.caseType).sort()).toEqual(['exact_match', 'residual_no_match']);
  });
});
