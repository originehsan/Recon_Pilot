import { describe, expect, it } from 'vitest';
import { binAmountDelta, binStringSimilarity, estimateFSParameters, scoreCandidateFS } from './fellegiSunter';
import { LabeledCandidate } from './buildTrainingLabels';
import { CandidatePair, LedgerOrder, Settlement } from './types';

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

function makeLabeled(
  isTrueMatch: boolean,
  stringSimilarity: number,
  amountDelta: number,
): LabeledCandidate {
  return {
    settlement: makeSettlement(1),
    order: makeOrder(1),
    amountDelta,
    dateDeltaDays: null,
    stringSimilarity,
    isTrueMatch,
  };
}

describe('binStringSimilarity', () => {
  it('bins HIGH at and above 0.85', () => {
    expect(binStringSimilarity(0.85)).toBe('HIGH');
    expect(binStringSimilarity(1)).toBe('HIGH');
  });
  it('bins MEDIUM for [0.6, 0.85)', () => {
    expect(binStringSimilarity(0.6)).toBe('MEDIUM');
    expect(binStringSimilarity(0.84)).toBe('MEDIUM');
  });
  it('bins LOW below 0.6', () => {
    expect(binStringSimilarity(0.59)).toBe('LOW');
    expect(binStringSimilarity(0)).toBe('LOW');
  });
});

describe('binAmountDelta', () => {
  it('bins EXACT at and below 5 paise', () => {
    expect(binAmountDelta(0)).toBe('EXACT');
    expect(binAmountDelta(5)).toBe('EXACT');
  });
  it('bins CLOSE for [6, 1000]', () => {
    expect(binAmountDelta(6)).toBe('CLOSE');
    expect(binAmountDelta(1000)).toBe('CLOSE');
  });
  it('bins FAR above 1000', () => {
    expect(binAmountDelta(1001)).toBe('FAR');
  });
});

describe('estimateFSParameters', () => {
  // 2 true matches: both HIGH similarity, both EXACT amount.
  // 3 non-matches: 2 LOW/FAR, 1 MEDIUM/CLOSE.
  const labeled: LabeledCandidate[] = [
    makeLabeled(true, 0.9, 0),
    makeLabeled(true, 0.95, 2),
    makeLabeled(false, 0.1, 5000),
    makeLabeled(false, 0.2, 6000),
    makeLabeled(false, 0.7, 500),
  ];

  const params = estimateFSParameters(labeled);

  it('applies add-1 smoothing to string-similarity m values (3 bins, 2 true matches)', () => {
    expect(params.stringSimilarity.HIGH.m).toBeCloseTo((2 + 1) / (2 + 3), 10); // 0.6
    expect(params.stringSimilarity.MEDIUM.m).toBeCloseTo((0 + 1) / (2 + 3), 10); // 0.2
    expect(params.stringSimilarity.LOW.m).toBeCloseTo((0 + 1) / (2 + 3), 10); // 0.2
  });

  it('applies add-1 smoothing to string-similarity u values (3 bins, 3 non-matches)', () => {
    expect(params.stringSimilarity.HIGH.u).toBeCloseTo((0 + 1) / (3 + 3), 10); // 1/6
    expect(params.stringSimilarity.MEDIUM.u).toBeCloseTo((1 + 1) / (3 + 3), 10); // 2/6
    expect(params.stringSimilarity.LOW.u).toBeCloseTo((2 + 1) / (3 + 3), 10); // 3/6
  });

  it('applies add-1 smoothing to amount-delta m and u values', () => {
    expect(params.amountDelta.EXACT.m).toBeCloseTo((2 + 1) / (2 + 3), 10); // 0.6
    expect(params.amountDelta.CLOSE.m).toBeCloseTo((0 + 1) / (2 + 3), 10); // 0.2
    expect(params.amountDelta.FAR.m).toBeCloseTo((0 + 1) / (2 + 3), 10); // 0.2

    expect(params.amountDelta.EXACT.u).toBeCloseTo((0 + 1) / (3 + 3), 10); // 1/6
    expect(params.amountDelta.CLOSE.u).toBeCloseTo((1 + 1) / (3 + 3), 10); // 2/6
    expect(params.amountDelta.FAR.u).toBeCloseTo((2 + 1) / (3 + 3), 10); // 3/6
  });

  it('never produces a zero m or u even for a bin with no observations', () => {
    for (const bin of Object.values(params.stringSimilarity)) {
      expect(bin.m).toBeGreaterThan(0);
      expect(bin.u).toBeGreaterThan(0);
    }
    for (const bin of Object.values(params.amountDelta)) {
      expect(bin.m).toBeGreaterThan(0);
      expect(bin.u).toBeGreaterThan(0);
    }
  });
});

describe('scoreCandidateFS', () => {
  const params = {
    stringSimilarity: {
      HIGH: { m: 0.5, u: 0.25 },
      MEDIUM: { m: 0.3, u: 0.3 },
      LOW: { m: 0.2, u: 0.45 },
    },
    amountDelta: {
      EXACT: { m: 0.6, u: 0.1 },
      CLOSE: { m: 0.3, u: 0.3 },
      FAR: { m: 0.1, u: 0.6 },
    },
  };

  it('computes the sum of log2 likelihood ratios for the correct bins', () => {
    const candidate: CandidatePair = {
      settlement: makeSettlement(1),
      order: makeOrder(1),
      amountDelta: 3, // <= 5 -> EXACT
      dateDeltaDays: null,
      stringSimilarity: 0.9, // >= 0.85 -> HIGH
    };

    const score = scoreCandidateFS(candidate, params);
    const expected = Math.log2(0.5 / 0.25) + Math.log2(0.6 / 0.1); // log2(2) + log2(6)

    expect(score).toBeCloseTo(expected, 10);
  });

  it('uses the absolute value of amountDelta to pick the bin', () => {
    const candidate: CandidatePair = {
      settlement: makeSettlement(1),
      order: makeOrder(1),
      amountDelta: -3, // abs = 3 -> still EXACT
      dateDeltaDays: null,
      stringSimilarity: 0.9,
    };

    const score = scoreCandidateFS(candidate, params);
    const expected = Math.log2(0.5 / 0.25) + Math.log2(0.6 / 0.1);

    expect(score).toBeCloseTo(expected, 10);
  });

  it('throws when stringSimilarity has not been computed yet (null)', () => {
    const candidate: CandidatePair = {
      settlement: makeSettlement(1),
      order: makeOrder(1),
      amountDelta: 0,
      dateDeltaDays: null,
      stringSimilarity: null,
    };

    expect(() => scoreCandidateFS(candidate, params)).toThrow();
  });
});
