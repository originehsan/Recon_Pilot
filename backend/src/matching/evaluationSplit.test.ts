import { describe, expect, it } from 'vitest';
import { splitLabeledCandidates } from './evaluationSplit';
import { LabeledCandidate } from './buildTrainingLabels';
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

function makeLabeledSet(count: number): LabeledCandidate[] {
  const candidates: LabeledCandidate[] = [];
  for (let i = 0; i < count; i++) {
    candidates.push({
      settlement: makeSettlement(i),
      order: makeOrder(i),
      amountDelta: i,
      dateDeltaDays: null,
      stringSimilarity: 0.5,
      isTrueMatch: i % 2 === 0,
    });
  }
  return candidates;
}

describe('splitLabeledCandidates', () => {
  it('is deterministic: the same seed always produces the same split', () => {
    const candidates = makeLabeledSet(50);

    const first = splitLabeledCandidates(candidates, 0.7, 42);
    const second = splitLabeledCandidates(candidates, 0.7, 42);

    expect(first.train.map((c) => c.settlement.id)).toEqual(second.train.map((c) => c.settlement.id));
    expect(first.test.map((c) => c.settlement.id)).toEqual(second.test.map((c) => c.settlement.id));
  });

  it('produces a different split for a different seed', () => {
    const candidates = makeLabeledSet(50);

    const seed42 = splitLabeledCandidates(candidates, 0.7, 42);
    const seed7 = splitLabeledCandidates(candidates, 0.7, 7);

    expect(seed42.train.map((c) => c.settlement.id)).not.toEqual(seed7.train.map((c) => c.settlement.id));
  });

  it('train + test sizes sum to the original total', () => {
    const candidates = makeLabeledSet(37); // odd number, exercises rounding

    const { train, test } = splitLabeledCandidates(candidates, 0.7, 42);

    expect(train.length + test.length).toBe(candidates.length);
  });

  it('no candidate appears in both sets', () => {
    const candidates = makeLabeledSet(50);

    const { train, test } = splitLabeledCandidates(candidates, 0.7, 42);

    const trainIds = new Set(train.map((c) => c.settlement.id));
    const testIds = new Set(test.map((c) => c.settlement.id));

    for (const id of trainIds) {
      expect(testIds.has(id)).toBe(false);
    }
    // Together they cover every original candidate exactly once.
    expect(trainIds.size).toBe(train.length);
    expect(testIds.size).toBe(test.length);
    expect(trainIds.size + testIds.size).toBe(candidates.length);
  });

  it('respects trainRatio (approximately, via rounding) for the split sizes', () => {
    const candidates = makeLabeledSet(100);

    const { train, test } = splitLabeledCandidates(candidates, 0.7, 42);

    expect(train.length).toBe(70);
    expect(test.length).toBe(30);
  });

  it('defaults trainRatio to 0.7 when not provided', () => {
    const candidates = makeLabeledSet(100);

    const { train, test } = splitLabeledCandidates(candidates, undefined as unknown as number, 42);

    expect(train.length).toBe(70);
    expect(test.length).toBe(30);
  });
});
