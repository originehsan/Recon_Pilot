import { describe, expect, it, vi } from 'vitest';
import { calibrateThresholds } from './calibrateThresholds';
import { LabeledCandidate } from './buildTrainingLabels';
import { FSParameters } from './fellegiSunter';
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

function makeLabeled(isTrueMatch: boolean, stringSimilarity: number, amountDelta: number): LabeledCandidate {
  return {
    settlement: makeSettlement(1),
    order: makeOrder(1),
    amountDelta,
    dateDeltaDays: null,
    stringSimilarity,
    isTrueMatch,
  };
}

// String-similarity params are neutral (m === u for every bin, log ratio 0)
// so the FS score is driven entirely by the amount-delta bin, giving fully
// predictable scores to test the threshold boundary logic against:
//   EXACT -> +3, CLOSE -> 0, FAR -> -3
const params: FSParameters = {
  stringSimilarity: {
    HIGH: { m: 0.5, u: 0.5 },
    MEDIUM: { m: 0.5, u: 0.5 },
    LOW: { m: 0.5, u: 0.5 },
  },
  amountDelta: {
    EXACT: { m: 0.8, u: 0.1 }, // log2(8) = 3
    CLOSE: { m: 0.4, u: 0.4 }, // log2(1) = 0
    FAR: { m: 0.1, u: 0.8 }, // log2(0.125) = -3
  },
};

describe('calibrateThresholds', () => {
  it('sets upper to the minimum true-match score and lower to the best-scoring non-match below it', () => {
    const labeled: LabeledCandidate[] = [
      makeLabeled(true, 0.9, 0), // HIGH/EXACT -> score 3
      makeLabeled(true, 0.9, 3), // HIGH/EXACT -> score 3
      makeLabeled(true, 0.7, 500), // MEDIUM/CLOSE -> score 0  <- minimum true-match score
      makeLabeled(false, 0.9, 2000), // FAR -> score -3         <- best non-match below upper(0)
      makeLabeled(false, 0.7, 500), // CLOSE -> score 0 (== upper, excluded - not strictly below)
    ];

    const thresholds = calibrateThresholds(labeled, params);

    expect(thresholds.upper).toBeCloseTo(0, 10);
    expect(thresholds.lower).toBeCloseTo(-3, 10);
  });

  it('collapses the review band to lower = upper when no non-match scores below the upper bound', () => {
    const labeled: LabeledCandidate[] = [
      makeLabeled(true, 0.9, 0), // score 3
      makeLabeled(true, 0.9, 3), // score 3
      makeLabeled(true, 0.9, 5), // score 3, minimum == 3
      makeLabeled(false, 0.9, 0), // score 3 (not below upper)
    ];

    const thresholds = calibrateThresholds(labeled, params);

    expect(thresholds.upper).toBeCloseTo(3, 10);
    expect(thresholds.lower).toBeCloseTo(3, 10);
  });

  it('falls back to upper=5.0, lower=0.0 and warns when fewer than 3 true matches exist', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const labeled: LabeledCandidate[] = [
      makeLabeled(true, 0.9, 0),
      makeLabeled(false, 0.1, 5000),
      makeLabeled(false, 0.1, 6000),
    ];

    const thresholds = calibrateThresholds(labeled, params);

    expect(thresholds).toEqual({ upper: 5.0, lower: 0.0 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/only 1 true-match/i);

    warnSpy.mockRestore();
  });

  it('falls back when there are zero true matches at all', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const labeled: LabeledCandidate[] = [makeLabeled(false, 0.1, 5000), makeLabeled(false, 0.1, 6000)];

    const thresholds = calibrateThresholds(labeled, params);

    expect(thresholds).toEqual({ upper: 5.0, lower: 0.0 });
    warnSpy.mockRestore();
  });
});
