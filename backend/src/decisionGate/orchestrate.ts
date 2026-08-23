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
import { Settlement } from '../matching/types';
import { getCurrentResolutionId } from './decisionGate';
import { upsertMatchCandidate, linkCompositeGroup } from './matchCandidateRepository';
import { persistAIInvestigationResult } from './persistAIInvestigation';
import { routeAfterAIInvestigation, routeDeterministicCase, RoutingContext, EVIDENCE_VERSION } from './routingPolicy';

const ALGORITHM_VERSION = 'v1';

/**
 * True only if EVERY settlement in the case already has a non-superseded
 * resolutions row - i.e. a prior orchestration pass already finalized this
 * whole case. Uses getCurrentResolutionId (decisionGate.ts), the exact same
 * head-of-chain lookup finalizeCase itself relies on internally - no new
 * resolutions-table query pattern introduced here.
 *
 * Deliberately ALL, not ANY: under this codebase's own routing design a
 * multi-settlement ai_investigation case is always finalized or reviewed as
 * one atomic group (see routingPolicy.ts's routeAfterAIInvestigation), so a
 * partially-resolved case should never occur in practice - but if it
 * somehow did, re-investigating rather than silently treating it as "done"
 * is the safer failure mode.
 */
async function allSettlementsAlreadyResolved(settlements: Settlement[]): Promise<boolean> {
  if (settlements.length === 0) {
    return false;
  }
  for (const settlement of settlements) {
    const resolutionId = await getCurrentResolutionId(settlement.id);
    if (resolutionId === null) {
      return false;
    }
  }
  return true;
}

export type InvestigateFn = (bundle: EvidenceBundle) => Promise<AIInvestigationResult>;

// Added for backend/src/api/routes/runs.ts (Step 3): a coarse progress
// snapshot, not per-stage tracking (explicitly out of scope per that
// prompt's Step 0.2). `resolved` names the finalized-case count using the
// API's own vocabulary (batch_runs.progress's documented shape), matching
// the field name POST /api/runs's spec gives it, rather than reusing
// orchestrateBatch's internal `finalized` name.
export interface ProgressCounts {
  totalCases: number;
  processed: number;
  resolved: number;
  reviewQueued: number;
  failed: number;
}

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

  // Safety mechanism: never re-spend a real Gemini call on a case already
  // finalized by a prior run. Critical given the 20/day free-tier quota -
  // dbLoader.ts loads every settlement unconditionally on every run (see
  // Step 0.1 of the API-layer prompt: no resolution-status filtering exists
  // upstream), so without this check, POST /api/runs would re-investigate
  // every already-settled ai_investigation case again on every subsequent
  // run. Note this only catches cases that reached a terminal resolution -
  // a case still sitting in review_queue (never finalized) has no
  // resolutions row yet and will still be re-investigated on the next run,
  // which is a real, disclosed limitation, not something this check claims
  // to solve.
  if (await allSettlementsAlreadyResolved(routedCase.settlements)) {
    return 'finalized';
  }

  const { bundle, tokenToSettlementId } = buildEvidenceBundle(routedCase);
  const aiResult = await investigateFn(bundle);

  const primaryMatchCandidateId = matchCandidateIdBySettlementId.get(routedCase.settlements[0].id)!;
  const aiInvestigationId = await persistAIInvestigationResult(primaryMatchCandidateId, bundle, EVIDENCE_VERSION, aiResult);

  return routeAfterAIInvestigation(routedCase, aiResult, aiInvestigationId, tokenToSettlementId, context);
}

/**
 * `onProgress` is an added parameter, backward-compatible via a no-op
 * default (existing callers - verifyDecisionGate.ts, this file's own test
 * suite - are unaffected). Invoked every 5 cases and always on the last one,
 * not after every single case: at real-run scale this is a per-case DB
 * write (see runs.ts), and batching it bounds write pressure while still
 * keeping batch_runs.progress reasonably fresh - a deliberate choice, not
 * the only valid one (per-case would also be correct, just chattier).
 */
export async function orchestrateBatch(
  routedCases: RoutedCase[],
  investigateFn: InvestigateFn,
  thresholds: Thresholds,
  onProgress: (progress: ProgressCounts) => void | Promise<void> = () => {},
): Promise<{ finalized: number; reviewQueued: number; failed: number }> {
  let finalized = 0;
  let reviewQueued = 0;
  let failed = 0;
  const totalCases = routedCases.length;

  for (let i = 0; i < routedCases.length; i++) {
    const routedCase = routedCases[i];
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

    const processed = finalized + reviewQueued + failed;
    const isLastCase = i === routedCases.length - 1;
    if (processed % 5 === 0 || isLastCase) {
      await onProgress({ totalCases, processed, resolved: finalized, reviewQueued, failed });
    }
  }

  return { finalized, reviewQueued, failed };
}
