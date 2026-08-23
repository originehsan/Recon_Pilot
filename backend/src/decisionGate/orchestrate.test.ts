import { describe, expect, it, vi, beforeEach } from 'vitest';
import { orchestrateBatch, InvestigateFn } from './orchestrate';
import { upsertMatchCandidate, linkCompositeGroup } from './matchCandidateRepository';
import { persistAIInvestigationResult } from './persistAIInvestigation';
import { routeAfterAIInvestigation, routeDeterministicCase } from './routingPolicy';
import { insertAuditEvent } from '../audit/auditRepository';
import { RoutedCase } from '../matching/thresholdGate';
import { LedgerOrder, Settlement } from '../matching/types';
import { AIInvestigationResult } from '../aiInvestigation/investigate';
import { Thresholds } from '../matching/calibrateThresholds';

vi.mock('./matchCandidateRepository', () => ({
  upsertMatchCandidate: vi.fn(async () => 1),
  linkCompositeGroup: vi.fn(async () => {}),
}));
vi.mock('./persistAIInvestigation', () => ({ persistAIInvestigationResult: vi.fn(async () => 999) }));
vi.mock('./routingPolicy', async () => {
  const actual = await vi.importActual<typeof import('./routingPolicy')>('./routingPolicy');
  return {
    ...actual,
    routeDeterministicCase: vi.fn(async () => 'finalized' as const),
    routeAfterAIInvestigation: vi.fn(async () => 'reviewed' as const),
  };
});
vi.mock('../audit/auditRepository', () => ({ insertAuditEvent: vi.fn(async () => {}) }));

beforeEach(() => {
  vi.mocked(upsertMatchCandidate).mockClear().mockImplementation(async () => 1);
  vi.mocked(linkCompositeGroup).mockClear();
  vi.mocked(persistAIInvestigationResult).mockClear().mockImplementation(async () => 999);
  vi.mocked(routeDeterministicCase).mockClear().mockImplementation(async () => 'finalized');
  vi.mocked(routeAfterAIInvestigation).mockClear().mockImplementation(async () => 'reviewed');
  vi.mocked(insertAuditEvent).mockClear();
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

const fakeInvestigateFn: InvestigateFn = vi.fn(async (): Promise<AIInvestigationResult> => ({
  status: 'success',
  classification: { classification: 'INSUFFICIENT_EVIDENCE', selectedTokens: [], confidence: 0.2, explanation: 'x' },
  rawResponse: '{}',
  latencyMs: 100,
  errorMessage: null,
}));

describe('orchestrateBatch', () => {
  it('routes a deterministic case (no AI call) via routeDeterministicCase and counts it as finalized', async () => {
    const routedCase: RoutedCase = {
      caseType: 'exact_match',
      settlements: [makeSettlement({ id: 1 })],
      order: makeOrder({ id: 1 }),
      fsScore: null,
      route: 'auto_resolve',
      reasonCode: 'exact_id_and_amount_match',
    };

    const summary = await orchestrateBatch([routedCase], fakeInvestigateFn, thresholds);

    expect(summary).toEqual({ finalized: 1, reviewQueued: 0, failed: 0 });
    expect(routeDeterministicCase).toHaveBeenCalledTimes(1);
    expect(routeAfterAIInvestigation).not.toHaveBeenCalled();
    expect(fakeInvestigateFn).not.toHaveBeenCalled();
    expect(upsertMatchCandidate).toHaveBeenCalledTimes(1);
  });

  it('routes an ai_investigation case through buildEvidenceBundle + investigateFn + persist + routeAfterAIInvestigation', async () => {
    const routedCase: RoutedCase = {
      caseType: 'ambiguous_duplicate',
      settlements: [makeSettlement({ id: 1 }), makeSettlement({ id: 2 })],
      order: makeOrder({ id: 1 }),
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'multiple_settlements_same_order_same_amount_no_discriminating_signal',
    };

    const summary = await orchestrateBatch([routedCase], fakeInvestigateFn, thresholds);

    expect(summary).toEqual({ finalized: 0, reviewQueued: 1, failed: 0 });
    expect(fakeInvestigateFn).toHaveBeenCalledTimes(1);
    const bundleArg = vi.mocked(fakeInvestigateFn).mock.calls[0][0];
    expect(bundleArg.caseType).toBe('ambiguous_duplicate');
    expect(persistAIInvestigationResult).toHaveBeenCalledWith(1, bundleArg, 1, expect.objectContaining({ status: 'success' }));
    expect(routeAfterAIInvestigation).toHaveBeenCalledTimes(1);
    expect(routeDeterministicCase).not.toHaveBeenCalled();
  });

  it('links a composite group when a case has more than one settlement', async () => {
    vi.mocked(upsertMatchCandidate).mockResolvedValueOnce(11).mockResolvedValueOnce(12);
    const routedCase: RoutedCase = {
      caseType: 'split_payment',
      settlements: [makeSettlement({ id: 1 }), makeSettlement({ id: 2 })],
      order: makeOrder({ id: 1 }),
      fsScore: null,
      route: 'auto_resolve',
      reasonCode: 'unique_subset_sum_match',
    };

    await orchestrateBatch([routedCase], fakeInvestigateFn, thresholds);

    expect(linkCompositeGroup).toHaveBeenCalledWith([11, 12]);
  });

  it('does not link a composite group for a single-settlement case', async () => {
    const routedCase: RoutedCase = {
      caseType: 'exact_match',
      settlements: [makeSettlement({ id: 1 })],
      order: makeOrder({ id: 1 }),
      fsScore: null,
      route: 'auto_resolve',
      reasonCode: 'exact_id_and_amount_match',
    };

    await orchestrateBatch([routedCase], fakeInvestigateFn, thresholds);

    expect(linkCompositeGroup).not.toHaveBeenCalled();
  });

  it('one case failing does not abort the batch, and is logged via an audit event with actorType SYSTEM', async () => {
    vi.mocked(routeDeterministicCase).mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const failing: RoutedCase = {
      caseType: 'exact_match',
      settlements: [makeSettlement({ id: 1 })],
      order: makeOrder({ id: 1 }),
      fsScore: null,
      route: 'auto_resolve',
      reasonCode: 'exact_id_and_amount_match',
    };
    const succeeding: RoutedCase = {
      caseType: 'exact_match',
      settlements: [makeSettlement({ id: 2 })],
      order: makeOrder({ id: 2 }),
      fsScore: null,
      route: 'auto_resolve',
      reasonCode: 'exact_id_and_amount_match',
    };

    const summary = await orchestrateBatch([failing, succeeding], fakeInvestigateFn, thresholds);

    expect(summary).toEqual({ finalized: 1, reviewQueued: 0, failed: 1 });
    expect(insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'settlement',
        entityId: 1,
        stage: 'decision_gate',
        actorType: 'SYSTEM',
        decisionGateOutput: expect.objectContaining({ error: 'boom' }),
      }),
    );
  });

  it('a case with zero settlements is caught, counted as failed, and does not crash the batch', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const emptyCase: RoutedCase = {
      caseType: 'split_payment_ambiguous',
      settlements: [],
      order: makeOrder({ id: 1 }),
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'no_subset_sum_reconciles',
    };
    const normalCase: RoutedCase = {
      caseType: 'exact_match',
      settlements: [makeSettlement({ id: 1 })],
      order: makeOrder({ id: 1 }),
      fsScore: null,
      route: 'auto_resolve',
      reasonCode: 'exact_id_and_amount_match',
    };

    const summary = await orchestrateBatch([emptyCase, normalCase], fakeInvestigateFn, thresholds);

    expect(summary).toEqual({ finalized: 1, reviewQueued: 0, failed: 1 });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('tallies finalized/reviewQueued/failed correctly across a mixed batch', async () => {
    vi.mocked(routeDeterministicCase)
      .mockImplementationOnce(async () => 'finalized')
      .mockImplementationOnce(async () => 'reviewed');
    vi.mocked(routeAfterAIInvestigation).mockImplementationOnce(async () => 'finalized');

    const cases: RoutedCase[] = [
      {
        caseType: 'exact_match',
        settlements: [makeSettlement({ id: 1 })],
        order: makeOrder({ id: 1 }),
        fsScore: null,
        route: 'auto_resolve',
        reasonCode: 'x',
      },
      {
        caseType: 'residual_match',
        settlements: [makeSettlement({ id: 2 })],
        order: makeOrder({ id: 2 }),
        fsScore: 0,
        route: 'human_review',
        reasonCode: 'x',
      },
      {
        caseType: 'ambiguous_duplicate',
        settlements: [makeSettlement({ id: 3 }), makeSettlement({ id: 4 })],
        order: makeOrder({ id: 3 }),
        fsScore: null,
        route: 'ai_investigation',
        reasonCode: 'x',
      },
    ];

    const summary = await orchestrateBatch(cases, fakeInvestigateFn, thresholds);

    expect(summary).toEqual({ finalized: 2, reviewQueued: 1, failed: 0 });
  });
});
