// Step 7: wires everything together for a batch of RoutedCases. This is the
// only place that decides WHEN to build an evidence bundle and call the AI
// (via the injected investigateFn - never the real Gemini client imported
// directly, so tests and verification scripts can substitute a mock).
//
// `thresholds` is an added parameter beyond the prompt's literal two-arg
// signature: routingPolicy.ts's human_review priority scoring needs the
// SAME upper/lower bounds the matching pipeline used to route cases into
// that band in the first place (see matching/runFullPipeline.ts's
// FullPipelineResult, extended for exactly this reason) - there's no way to
// derive it from routedCases alone without guessing or redundantly
// recomputing the whole calibration pass.

import { RoutedCase } from '../matching/thresholdGate';
import { Thresholds } from '../matching/calibrateThresholds';
import { buildEvidenceBundle, EvidenceBundle } from '../aiInvestigation/evidenceBundle';
import { AIInvestigationResult } from '../aiInvestigation/investigate';
import { insertAuditEvent } from '../audit/auditRepository';
import { upsertMatchCandidate, linkCompositeGroup } from './matchCandidateRepository';
import { persistAIInvestigationResult } from './persistAIInvestigation';
import { routeAfterAIInvestigation, routeDeterministicCase, RoutingContext, EVIDENCE_VERSION } from './routingPolicy';

const ALGORITHM_VERSION = 'v1';

export type InvestigateFn = (bundle: EvidenceBundle) => Promise<AIInvestigationResult>;

async function processCase(routedCase: RoutedCase, investigateFn: InvestigateFn, thresholds: Thresholds): Promise<'finalized' | 'reviewed'> {
  if (routedCase.settlements.length === 0) {
    // Can genuinely happen: a split_payment_ambiguous NO_SOLUTION case has
    // an empty settlements array by design (see thresholdGate.ts - there's
    // no retained candidate list for that outcome). Nothing to act on;
    // fail loudly and specifically rather than crash later on
    // `settlements[0]` with a confusing undefined-property error.
    throw new Error(
      `orchestrateBatch: RoutedCase (caseType=${routedCase.caseType}, reasonCode=${routedCase.reasonCode}) has zero settlements.`,
    );
  }

  // Ensure every settlement in this case has a real match_candidates row
  // before any finalize/review-queue decision references it.
  const matchCandidateIdBySettlementId = new Map<number, number>();
  const matchCandidateIds: number[] = [];
  for (const settlement of routedCase.settlements) {
    const id = await upsertMatchCandidate({
      settlementId: settlement.id,
      ledgerOrderId: routedCase.order?.id ?? null,
      isComposite: routedCase.settlements.length > 1,
      fsScore: routedCase.fsScore,
      route: routedCase.route,
      algorithmVersion: ALGORITHM_VERSION,
    });
    matchCandidateIdBySettlementId.set(settlement.id, id);
    matchCandidateIds.push(id);
  }
  if (matchCandidateIds.length > 1) {
    await linkCompositeGroup(matchCandidateIds);
  }

  const context: RoutingContext = { matchCandidateIdBySettlementId, thresholds };

  if (routedCase.route !== 'ai_investigation') {
    return routeDeterministicCase(routedCase, context);
  }

  const { bundle, tokenToSettlementId } = buildEvidenceBundle(routedCase);
  const aiResult = await investigateFn(bundle);

  const primaryMatchCandidateId = matchCandidateIdBySettlementId.get(routedCase.settlements[0].id)!;
  const aiInvestigationId = await persistAIInvestigationResult(primaryMatchCandidateId, bundle, EVIDENCE_VERSION, aiResult);

  return routeAfterAIInvestigation(routedCase, aiResult, aiInvestigationId, tokenToSettlementId, context);
}

export async function orchestrateBatch(
  routedCases: RoutedCase[],
  investigateFn: InvestigateFn,
  thresholds: Thresholds,
): Promise<{ finalized: number; reviewQueued: number; failed: number }> {
  let finalized = 0;
  let reviewQueued = 0;
  let failed = 0;

  for (const routedCase of routedCases) {
    try {
      const outcome = await processCase(routedCase, investigateFn, thresholds);
      if (outcome === 'finalized') {
        finalized++;
      } else {
        reviewQueued++;
      }
    } catch (err) {
      // One case's failure must never abort the whole batch.
      failed++;
      const settlement = routedCase.settlements[0];
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (settlement) {
        try {
          await insertAuditEvent({
            entityType: 'settlement',
            entityId: settlement.id,
            stage: 'decision_gate',
            actorType: 'SYSTEM',
            evidenceUsed: null,
            aiRawOutput: null,
            decisionGateOutput: {
              error: errorMessage,
              caseType: routedCase.caseType,
              settlementIds: routedCase.settlements.map((s) => s.id),
            },
          });
        } catch (auditErr) {
          // Even logging the failure failed - don't let THAT crash the
          // batch either. Surface it on stderr instead.
          console.error('orchestrateBatch: failed to log audit event for a failed case:', auditErr);
        }
      } else {
        // No settlement at all (the zero-settlements guard above) - no real
        // entityId to attach an audit event to.
        console.error(
          `orchestrateBatch: case failed with no settlement to attach an audit event to (caseType=${routedCase.caseType}):`,
          errorMessage,
        );
      }
    }
  }

  return { finalized, reviewQueued, failed };
}
