import { describe, expect, it, vi, beforeEach } from 'vitest';
import { finalizeCase } from './decisionGate';
import { enqueueForReview } from './reviewQueue';
import { routeAfterAIInvestigation, routeDeterministicCase, RoutingContext, AI_AUTO_RESOLVE_CONFIDENCE_THRESHOLD } from './routingPolicy';
import { RoutedCase } from '../matching/thresholdGate';
import { LedgerOrder, Settlement } from '../matching/types';
import { AIInvestigationResult } from '../aiInvestigation/investigate';
import { Thresholds } from '../matching/calibrateThresholds';

vi.mock('./decisionGate', () => ({ finalizeCase: vi.fn(async () => ({}) as never) }));
vi.mock('./reviewQueue', () => ({ enqueueForReview: vi.fn(async () => {}) }));

beforeEach(() => {
  vi.mocked(finalizeCase).mockClear();
  vi.mocked(enqueueForReview).mockClear();
});

function makeSettlement(overrides: Partial<Settlement> & { id: number }): Settlement {
  return {
    entityId: `pay_${overrides.id}`,
    orderId: `order_${overrides.id}`,
    amount: 1000,
    fee: 20,
    tax: 4,
    settlementUtr: null,
    creditType: 'default',
    hasDispute: false,
    narration: null,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<LedgerOrder> & { id: number }): LedgerOrder {
  return { orderId: `order_${overrides.id}`, expectedAmount: 1000, expectedDate: null, ...overrides };
}

const thresholds: Thresholds = { upper: 10, lower: -10 };

function makeContext(matchCandidateIds: Record<number, number> = {}): RoutingContext {
  return { matchCandidateIdBySettlementId: new Map(Object.entries(matchCandidateIds).map(([k, v]) => [Number(k), v])), thresholds };
}

describe('routeDeterministicCase', () => {
  it('exact_match: finalizes as matched, decidedBy stage1_exact', async () => {
    const order = makeOrder({ id: 100 });
    const settlement = makeSettlement({ id: 1 });
    const routedCase: RoutedCase = {
      caseType: 'exact_match',
      settlements: [settlement],
      order,
      fsScore: null,
      route: 'auto_resolve',
      reasonCode: 'exact_id_and_amount_match',
    };

    const outcome = await routeDeterministicCase(routedCase, makeContext({ 1: 501 }));

    expect(outcome).toBe('finalized');
    expect(finalizeCase).toHaveBeenCalledTimes(1);
    expect(finalizeCase).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementIds: [1],
        ledgerOrderId: 100,
        finalStatus: 'matched',
        decidedBy: 'stage1_exact',
        matchCandidateId: 501,
        aiInvestigationId: null,
        reasonCode: 'exact_id_and_amount_match',
      }),
    );
    expect(enqueueForReview).not.toHaveBeenCalled();
  });

  it('split_payment: finalizes ALL settlements in the group as matched, decidedBy stage7_auto', async () => {
    const order = makeOrder({ id: 200 });
    const s1 = makeSettlement({ id: 1 });
    const s2 = makeSettlement({ id: 2 });
    const routedCase: RoutedCase = {
      caseType: 'split_payment',
      settlements: [s1, s2],
      order,
      fsScore: null,
      route: 'auto_resolve',
      reasonCode: 'unique_subset_sum_match',
    };

    const outcome = await routeDeterministicCase(routedCase, makeContext({ 1: 601 }));

    expect(outcome).toBe('finalized');
    expect(finalizeCase).toHaveBeenCalledWith(
      expect.objectContaining({ settlementIds: [1, 2], finalStatus: 'matched', decidedBy: 'stage7_auto', matchCandidateId: 601 }),
    );
  });

  it('residual_match + auto_resolve: finalizes as matched, decidedBy stage7_auto (gap-filled branch)', async () => {
    const order = makeOrder({ id: 300 });
    const settlement = makeSettlement({ id: 1 });
    const routedCase: RoutedCase = {
      caseType: 'residual_match',
      settlements: [settlement],
      order,
      fsScore: 15,
      route: 'auto_resolve',
      reasonCode: 'fs_score_above_calibrated_threshold',
    };

    const outcome = await routeDeterministicCase(routedCase, makeContext({ 1: 701 }));

    expect(outcome).toBe('finalized');
    expect(finalizeCase).toHaveBeenCalledWith(
      expect.objectContaining({ finalStatus: 'matched', decidedBy: 'stage7_auto', reasonCode: 'fs_score_above_calibrated_threshold' }),
    );
  });

  it('residual_match + human_review: enqueues for review with linearly-normalized priorityScore', async () => {
    const settlement = makeSettlement({ id: 1, amount: 8000 });
    const routedCase: RoutedCase = {
      caseType: 'residual_match',
      settlements: [settlement],
      order: makeOrder({ id: 400 }),
      fsScore: 0, // midpoint of [-10, 10] -> pseudoConfidence 0.5
      route: 'human_review',
      reasonCode: 'fs_score_in_review_band',
    };

    const outcome = await routeDeterministicCase(routedCase, makeContext({ 1: 801 }));

    expect(outcome).toBe('reviewed');
    expect(finalizeCase).not.toHaveBeenCalled();
    expect(enqueueForReview).toHaveBeenCalledWith({
      matchCandidateId: 801,
      reasonCode: 'fs_score_in_review_band',
      exposureAmount: 8000,
      priorityScore: 4000, // (1 - 0.5) * 8000
    });
  });

  it('residual_match + human_review: clamps pseudoConfidence to [0,1] for an out-of-band fsScore', async () => {
    const settlement = makeSettlement({ id: 1, amount: 1000 });
    const routedCase: RoutedCase = {
      caseType: 'residual_match',
      settlements: [settlement],
      order: makeOrder({ id: 1 }),
      fsScore: 999, // way above upper(10) - should clamp pseudoConfidence to 1, priority to 0
      route: 'human_review',
      reasonCode: 'fs_score_in_review_band',
    };

    await routeDeterministicCase(routedCase, makeContext({ 1: 1 }));

    expect(enqueueForReview).toHaveBeenCalledWith(expect.objectContaining({ priorityScore: 0 }));
  });

  it('amount_mismatch: enqueues for review at max priority (no FS score to normalize against)', async () => {
    const settlement = makeSettlement({ id: 1, amount: 8000 });
    const routedCase: RoutedCase = {
      caseType: 'amount_mismatch',
      settlements: [settlement],
      order: makeOrder({ id: 500 }),
      fsScore: null,
      route: 'human_review',
      reasonCode: 'settlement_amount_does_not_reconcile_no_split_solution',
    };

    const outcome = await routeDeterministicCase(routedCase, makeContext({ 1: 901 }));

    expect(outcome).toBe('reviewed');
    expect(finalizeCase).not.toHaveBeenCalled();
    expect(enqueueForReview).toHaveBeenCalledWith({
      matchCandidateId: 901,
      reasonCode: 'settlement_amount_does_not_reconcile_no_split_solution',
      exposureAmount: 8000,
      priorityScore: 8000,
    });
  });

  it('throws for a caseType that requires AI investigation', async () => {
    const routedCase: RoutedCase = {
      caseType: 'ambiguous_duplicate',
      settlements: [makeSettlement({ id: 1 })],
      order: makeOrder({ id: 1 }),
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'x',
    };

    await expect(routeDeterministicCase(routedCase, makeContext())).rejects.toThrow(/requires AI investigation/);
  });
});

describe('routeAfterAIInvestigation', () => {
  function successResult(overrides: Partial<AIInvestigationResult['classification']> = {}): AIInvestigationResult {
    return {
      status: 'success',
      classification: {
        classification: 'MATCH_FOUND',
        selectedTokens: ['CANDIDATE_A'],
        confidence: 0.95,
        explanation: 'x',
        ...overrides,
      },
      rawResponse: '{}',
      latencyMs: 1000,
      errorMessage: null,
    };
  }

  it('residual_no_match: ALWAYS reviews, never finalizes, regardless of classification', async () => {
    const settlement = makeSettlement({ id: 1, amount: 500 });
    const routedCase: RoutedCase = {
      caseType: 'residual_no_match',
      settlements: [settlement],
      order: null,
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'no_viable_candidate_in_component',
    };

    const outcome = await routeAfterAIInvestigation(
      routedCase,
      successResult({ classification: 'MATCH_FOUND' } as never),
      999,
      new Map([['CANDIDATE_A', 1]]),
      makeContext({ 1: 901 }),
    );

    expect(outcome).toBe('reviewed');
    expect(finalizeCase).not.toHaveBeenCalled();
    expect(enqueueForReview).toHaveBeenCalledWith(
      expect.objectContaining({ matchCandidateId: 901, reasonCode: 'no_viable_candidate_ai_reviewed_narration' }),
    );
  });

  it.each([
    ['timeout', 'ai_timeout'],
    ['error', 'ai_error'],
    ['invalid_output', 'ai_invalid_output'],
  ] as const)('ambiguous_duplicate: AI status "%s" -> reviewed with reasonCode "%s", pseudoConfidence 0.3', async (status, expectedReasonCode) => {
    const s1 = makeSettlement({ id: 1, amount: 300 });
    const s2 = makeSettlement({ id: 2, amount: 300 });
    const routedCase: RoutedCase = {
      caseType: 'ambiguous_duplicate',
      settlements: [s1, s2],
      order: makeOrder({ id: 1 }),
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'x',
    };
    const failedResult: AIInvestigationResult = {
      status,
      classification: null,
      rawResponse: status === 'invalid_output' ? 'garbled' : null,
      latencyMs: 1000,
      errorMessage: 'x',
    };

    await routeAfterAIInvestigation(routedCase, failedResult, 1, new Map(), makeContext({ 1: 11, 2: 12 }));

    expect(finalizeCase).not.toHaveBeenCalled();
    // Enqueued once PER SETTLEMENT in the group (not once for the whole
    // case) - otherwise the non-primary settlement is left with no
    // resolutions row AND no review_queue row anywhere, i.e. untraceable.
    expect(enqueueForReview).toHaveBeenCalledTimes(2);
    expect(enqueueForReview).toHaveBeenNthCalledWith(1, {
      matchCandidateId: 11,
      reasonCode: expectedReasonCode,
      exposureAmount: 600,
      priorityScore: 0.7 * 600,
    });
    expect(enqueueForReview).toHaveBeenNthCalledWith(2, {
      matchCandidateId: 12,
      reasonCode: expectedReasonCode,
      exposureAmount: 600,
      priorityScore: 0.7 * 600,
    });
  });

  it('ambiguous_duplicate: MATCH_FOUND + 1 token + confidence >= threshold finalizes winner as matched and loser(s) as rejected', async () => {
    const s1 = makeSettlement({ id: 1, amount: 1000 });
    const s2 = makeSettlement({ id: 2, amount: 1000 });
    const routedCase: RoutedCase = {
      caseType: 'ambiguous_duplicate',
      settlements: [s1, s2],
      order: makeOrder({ id: 50 }),
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'x',
    };
    const result = successResult({
      classification: 'MATCH_FOUND',
      selectedTokens: ['CANDIDATE_B'],
      confidence: AI_AUTO_RESOLVE_CONFIDENCE_THRESHOLD,
    } as never);
    const tokenMap = new Map([
      ['CANDIDATE_A', 1],
      ['CANDIDATE_B', 2],
    ]);

    const outcome = await routeAfterAIInvestigation(routedCase, result, 77, tokenMap, makeContext({ 1: 11, 2: 12 }));

    expect(outcome).toBe('finalized');
    expect(finalizeCase).toHaveBeenCalledTimes(2);
    expect(finalizeCase).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        settlementIds: [2],
        finalStatus: 'matched',
        decidedBy: 'post_ai',
        matchCandidateId: 12,
        aiInvestigationId: 77,
        reasonCode: 'ai_investigation_confident_match',
      }),
    );
    expect(finalizeCase).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        settlementIds: [1],
        finalStatus: 'rejected',
        decidedBy: 'post_ai',
        matchCandidateId: 11,
        aiInvestigationId: 77,
        reasonCode: 'lost_ambiguous_duplicate_tiebreak',
      }),
    );
    expect(enqueueForReview).not.toHaveBeenCalled();
  });

  it('ambiguous_duplicate: MULTIPLE_MATCH_FOUND is treated as an invalid combination and routed to review', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s1 = makeSettlement({ id: 1, amount: 500 });
    const s2 = makeSettlement({ id: 2, amount: 500 });
    const routedCase: RoutedCase = {
      caseType: 'ambiguous_duplicate',
      settlements: [s1, s2],
      order: makeOrder({ id: 1 }),
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'x',
    };
    const result = successResult({ classification: 'MULTIPLE_MATCH_FOUND', selectedTokens: ['CANDIDATE_A', 'CANDIDATE_B'], confidence: 0.9 } as never);

    const outcome = await routeAfterAIInvestigation(routedCase, result, 1, new Map(), makeContext({ 1: 11, 2: 12 }));

    expect(outcome).toBe('reviewed');
    expect(finalizeCase).not.toHaveBeenCalled();
    // Once per settlement in the group - see the earlier "AI status" test
    // for why (both must end up traceable, not just the primary one).
    expect(enqueueForReview).toHaveBeenCalledTimes(2);
    expect(enqueueForReview).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ matchCandidateId: 11, reasonCode: 'ai_returned_invalid_combination_for_case_type' }),
    );
    expect(enqueueForReview).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ matchCandidateId: 12, reasonCode: 'ai_returned_invalid_combination_for_case_type' }),
    );
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    consoleWarnSpy.mockRestore();
  });

  it.each(['NO_VIABLE_MATCH', 'INSUFFICIENT_EVIDENCE'] as const)(
    'ambiguous_duplicate: classification %s routes to review using the AI\'s own confidence',
    async (classification) => {
      const settlement = makeSettlement({ id: 1, amount: 100 });
      const routedCase: RoutedCase = {
        caseType: 'ambiguous_duplicate',
        settlements: [settlement],
        order: makeOrder({ id: 1 }),
        fsScore: null,
        route: 'ai_investigation',
        reasonCode: 'x',
      };
      const result = successResult({ classification, selectedTokens: [], confidence: 0.4 } as never);

      await routeAfterAIInvestigation(routedCase, result, 1, new Map(), makeContext({ 1: 5 }));

      expect(enqueueForReview).toHaveBeenCalledWith(
        expect.objectContaining({ reasonCode: `ai_classification_${classification.toLowerCase()}`, priorityScore: 0.6 * 100 }),
      );
    },
  );

  it('ambiguous_duplicate: MATCH_FOUND below the confidence threshold routes to review, not auto-finalize', async () => {
    const settlement = makeSettlement({ id: 1, amount: 100 });
    const routedCase: RoutedCase = {
      caseType: 'ambiguous_duplicate',
      settlements: [settlement],
      order: makeOrder({ id: 1 }),
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'x',
    };
    const result = successResult({ classification: 'MATCH_FOUND', selectedTokens: ['CANDIDATE_A'], confidence: 0.5 } as never);

    await routeAfterAIInvestigation(routedCase, result, 1, new Map([['CANDIDATE_A', 1]]), makeContext({ 1: 5 }));

    expect(finalizeCase).not.toHaveBeenCalled();
    expect(enqueueForReview).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'ai_classification_match_found' }));
  });

  it('split_payment_ambiguous: MULTIPLE_MATCH_FOUND with confidence >= threshold finalizes the resolved group as matched', async () => {
    const s1 = makeSettlement({ id: 1, amount: 400 });
    const s2 = makeSettlement({ id: 2, amount: 600 });
    const routedCase: RoutedCase = {
      caseType: 'split_payment_ambiguous',
      settlements: [s1, s2],
      order: makeOrder({ id: 60 }),
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'x',
    };
    const result = successResult({
      classification: 'MULTIPLE_MATCH_FOUND',
      selectedTokens: ['CANDIDATE_A', 'CANDIDATE_B'],
      confidence: 0.9,
    } as never);
    const tokenMap = new Map([
      ['CANDIDATE_A', 1],
      ['CANDIDATE_B', 2],
    ]);

    const outcome = await routeAfterAIInvestigation(routedCase, result, 88, tokenMap, makeContext({ 1: 21, 2: 22 }));

    expect(outcome).toBe('finalized');
    expect(finalizeCase).toHaveBeenCalledTimes(1);
    expect(finalizeCase).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementIds: [1, 2],
        ledgerOrderId: 60,
        finalStatus: 'matched',
        decidedBy: 'post_ai',
        aiInvestigationId: 88,
        reasonCode: 'ai_confirmed_split_payment_subset',
      }),
    );
    expect(enqueueForReview).not.toHaveBeenCalled();
  });

  it('split_payment_ambiguous: MULTIPLE_MATCH_FOUND below the confidence threshold routes to review', async () => {
    const s1 = makeSettlement({ id: 1, amount: 400 });
    const routedCase: RoutedCase = {
      caseType: 'split_payment_ambiguous',
      settlements: [s1],
      order: makeOrder({ id: 1 }),
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'x',
    };
    const result = successResult({ classification: 'MULTIPLE_MATCH_FOUND', selectedTokens: ['CANDIDATE_A'], confidence: 0.5 } as never);

    await routeAfterAIInvestigation(routedCase, result, 1, new Map([['CANDIDATE_A', 1]]), makeContext({ 1: 5 }));

    expect(finalizeCase).not.toHaveBeenCalled();
    expect(enqueueForReview).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'ai_classification_multiple_match_found' }));
  });

  it('split_payment_ambiguous: NO_VIABLE_MATCH routes to review', async () => {
    const s1 = makeSettlement({ id: 1, amount: 400 });
    const routedCase: RoutedCase = {
      caseType: 'split_payment_ambiguous',
      settlements: [s1],
      order: makeOrder({ id: 1 }),
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'x',
    };
    const result = successResult({ classification: 'NO_VIABLE_MATCH', selectedTokens: [], confidence: 0.2 } as never);

    await routeAfterAIInvestigation(routedCase, result, 1, new Map(), makeContext({ 1: 5 }));

    expect(finalizeCase).not.toHaveBeenCalled();
    expect(enqueueForReview).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'ai_classification_no_viable_match' }));
  });
});
