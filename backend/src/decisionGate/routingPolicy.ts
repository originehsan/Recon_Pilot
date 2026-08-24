// Step 4: the actual decision logic - what finalizeCase/enqueueForReview
// get called with, for every RoutedCase type. Deliberate safety design,
// spelled out explicitly rather than left to inference.
//
// GAP NOTE (flagged, not silently invented): the prompt's routing rules
// cover 'exact_match', 'split_payment', route='human_review', and the three
// AI-investigated case types - but never explicitly says what to do with
// caseType 'residual_match' + route='auto_resolve' (Stage 7 Rule 5's
// fsScore >= upper branch - a real, populated case in the seeded data: 27
// of them in the current dataset). Filled by direct symmetry with
// split_payment/exact_match's own already-specified handling and Rule 5's
// own reasonCode ('fs_score_above_calibrated_threshold'): finalize as
// matched, decidedBy 'stage7_auto' (the only enum value that fits - no AI
// was involved, it isn't stage1_exact, and it isn't human). See this
// prompt's final summary for where this is called out explicitly.

import { finalizeCase } from './decisionGate';
import { enqueueForReview } from './reviewQueue';
import { RoutedCase } from '../matching/thresholdGate';
import { Thresholds } from '../matching/calibrateThresholds';
import { Settlement } from '../matching/types';
import { AIInvestigationResult } from '../aiInvestigation/investigate';
import { resolveTokens } from '../aiInvestigation/resolveTokens';

// A starting heuristic bar the GATE imposes independently of the AI's own
// self-reported confidence number - not a calibrated threshold like the
// Fellegi-Sunter upper/lower bounds, which are fit from labeled data. This
// is a policy choice: "the AI must be at least this sure of itself, on its
// own scale, before we let it auto-finalize real money without a human."
export const AI_AUTO_RESOLVE_CONFIDENCE_THRESHOLD = 0.85;

// evidenceVersion is a placeholder constant for this prompt: real
// evidence-staleness/versioning is explicitly out of scope here (it belongs
// to a future decision-gate prompt, alongside the 'stale_evidence' status).
// Exported so orchestrate.ts's persistAIInvestigationResult call uses the
// exact same value, rather than a second constant that could drift.
export const EVIDENCE_VERSION = 1;

export interface RoutingContext {
  /** settlement.id -> match_candidates.id, populated by orchestrate.ts before routing. */
  matchCandidateIdBySettlementId: Map<number, number>;
  /** Needed only for the human_review priority-scoring branch. */
  thresholds: Thresholds;
}

function sumAmounts(settlements: Settlement[]): number {
  return settlements.reduce((sum, s) => sum + s.amount, 0);
}

function matchCandidateIdFor(settlementId: number, context: RoutingContext): number | null {
  return context.matchCandidateIdBySettlementId.get(settlementId) ?? null;
}

/**
 * enqueueForReview only ever takes ONE matchCandidateId (Step 5's given
 * signature has no array param). For a multi-settlement group being routed
 * to review together, calling it once for the whole group - referencing
 * only one "representative" settlement - left every OTHER settlement in
 * that group with no resolutions row AND no review_queue row anywhere:
 * genuinely untraceable, not just under-detailed. Confirmed live via
 * verify-decision-gate (9 of 18 AMBIGUOUS_DUPLICATE settlements came back
 * with no trace at all). Fixed by enqueuing once PER SETTLEMENT in the
 * group instead - exposureAmount and priorityScore stay the same
 * case-level values on every row (per the prompt's own formulas, which are
 * case-level, not per-settlement), but every settlement gets its own real,
 * queryable row.
 */
async function enqueueGroupForReview(
  settlements: Settlement[],
  context: RoutingContext,
  reasonCode: string,
  exposureAmount: number,
  priorityScore: number,
): Promise<void> {
  for (const settlement of settlements) {
    await enqueueForReview({
      matchCandidateId: matchCandidateIdFor(settlement.id, context),
      reasonCode,
      exposureAmount,
      priorityScore,
    });
  }
}

/**
 * Linearly normalizes an FS score into a 0-1 pseudo-confidence between
 * thresholds.lower and thresholds.upper, clamped to [0, 1]. Explicitly a
 * linear approximation, not a calibrated probability - that would need the
 * logistic-transform machinery this project hasn't built.
 */
function computeLinearPseudoConfidence(fsScore: number, thresholds: Thresholds): number {
  if (thresholds.upper === thresholds.lower) {
    // Degenerate calibration (e.g. the <3-true-matches fallback collapsed
    // the review band to a single point) - no meaningful gradient to
    // normalize against. Treated as maximally uncertain (highest review
    // priority) rather than dividing by zero.
    return 0;
  }
  const raw = (fsScore - thresholds.lower) / (thresholds.upper - thresholds.lower);
  return Math.min(1, Math.max(0, raw));
}

export type RoutingOutcome = 'finalized' | 'reviewed';

/**
 * Handles every RoutedCase that does NOT need AI investigation:
 * 'exact_match', 'split_payment', and 'residual_match' (both its
 * auto_resolve and human_review routes). Throws for any caseType that
 * requires AI - callers should check `routedCase.route === 'ai_investigation'`
 * first and use routeAfterAIInvestigation instead.
 */
export async function routeDeterministicCase(routedCase: RoutedCase, context: RoutingContext): Promise<RoutingOutcome> {
  switch (routedCase.caseType) {
    case 'exact_match': {
      const settlement = routedCase.settlements[0];
      await finalizeCase({
        settlementIds: [settlement.id],
        ledgerOrderId: routedCase.order!.id,
        finalStatus: 'matched',
        decidedBy: 'stage1_exact',
        matchCandidateId: matchCandidateIdFor(settlement.id, context),
        aiInvestigationId: null,
        evidenceVersion: EVIDENCE_VERSION,
        evidence: { caseType: routedCase.caseType, settlementId: settlement.id, orderId: routedCase.order!.id },
        reasonCode: routedCase.reasonCode,
      });
      return 'finalized';
    }

    case 'split_payment': {
      const settlementIds = routedCase.settlements.map((s) => s.id);
      await finalizeCase({
        settlementIds,
        ledgerOrderId: routedCase.order!.id,
        finalStatus: 'matched',
        decidedBy: 'stage7_auto',
        matchCandidateId: matchCandidateIdFor(settlementIds[0], context),
        aiInvestigationId: null,
        evidenceVersion: EVIDENCE_VERSION,
        evidence: { caseType: routedCase.caseType, settlementIds, orderId: routedCase.order!.id },
        reasonCode: routedCase.reasonCode,
      });
      return 'finalized';
    }

    case 'residual_match': {
      const settlement = routedCase.settlements[0];

      if (routedCase.route === 'auto_resolve') {
        // See GAP NOTE at the top of this file.
        await finalizeCase({
          settlementIds: [settlement.id],
          ledgerOrderId: routedCase.order!.id,
          finalStatus: 'matched',
          decidedBy: 'stage7_auto',
          matchCandidateId: matchCandidateIdFor(settlement.id, context),
          aiInvestigationId: null,
          evidenceVersion: EVIDENCE_VERSION,
          evidence: { caseType: routedCase.caseType, settlementId: settlement.id, orderId: routedCase.order!.id, fsScore: routedCase.fsScore },
          reasonCode: routedCase.reasonCode,
        });
        return 'finalized';
      }

      if (routedCase.route === 'human_review') {
        const pseudoConfidence = computeLinearPseudoConfidence(routedCase.fsScore!, context.thresholds);
        const exposureAmount = settlement.amount;
        await enqueueForReview({
          matchCandidateId: matchCandidateIdFor(settlement.id, context),
          reasonCode: 'fs_score_in_review_band',
          exposureAmount,
          priorityScore: (1 - pseudoConfidence) * exposureAmount,
        });
        return 'reviewed';
      }

      throw new Error(`routeDeterministicCase: unexpected route "${routedCase.route}" for caseType residual_match.`);
    }

    case 'amount_mismatch': {
      // No FS score exists for this caseType (see thresholdGate.ts's Rule
      // 2.5) - there's no gradient to normalize a pseudo-confidence against,
      // so this is treated as maximally uncertain (priorityScore ==
      // exposureAmount), the same fallback computeLinearPseudoConfidence
      // itself uses for its own degenerate case.
      const settlement = routedCase.settlements[0];
      await enqueueForReview({
        matchCandidateId: matchCandidateIdFor(settlement.id, context),
        reasonCode: routedCase.reasonCode,
        exposureAmount: settlement.amount,
        priorityScore: settlement.amount,
      });
      return 'reviewed';
    }

    default:
      throw new Error(
        `routeDeterministicCase: caseType "${routedCase.caseType}" requires AI investigation - use routeAfterAIInvestigation.`,
      );
  }
}

/**
 * Handles every RoutedCase that DOES need AI investigation
 * ('ambiguous_duplicate', 'split_payment_ambiguous', 'residual_no_match'),
 * given the AIInvestigationResult already obtained by the caller (this
 * function makes no LLM call itself) and the already-persisted
 * ai_investigations.id.
 */
export async function routeAfterAIInvestigation(
  routedCase: RoutedCase,
  aiResult: AIInvestigationResult,
  aiInvestigationId: number,
  tokenToSettlementId: Map<string, number>,
  context: RoutingContext,
): Promise<RoutingOutcome> {
  if (routedCase.caseType === 'residual_no_match') {
    // ALWAYS review_queue, never finalized as matched - there is no
    // ledger_order to attach a match to regardless of what the AI concludes
    // about the narration.
    const settlement = routedCase.settlements[0];
    const pseudoConfidence = aiResult.status === 'success' ? aiResult.classification!.confidence : 0.3;
    await enqueueForReview({
      matchCandidateId: matchCandidateIdFor(settlement.id, context),
      reasonCode: 'no_viable_candidate_ai_reviewed_narration',
      exposureAmount: settlement.amount,
      priorityScore: (1 - pseudoConfidence) * settlement.amount,
    });
    return 'reviewed';
  }

  if (routedCase.caseType !== 'ambiguous_duplicate' && routedCase.caseType !== 'split_payment_ambiguous') {
    throw new Error(`routeAfterAIInvestigation: unexpected caseType "${routedCase.caseType}".`);
  }

  const exposureAmount = sumAmounts(routedCase.settlements);
  const primaryMatchCandidateId = matchCandidateIdFor(routedCase.settlements[0].id, context);

  if (aiResult.status !== 'success') {
    const reasonCode =
      aiResult.status === 'timeout' ? 'ai_timeout' : aiResult.status === 'error' ? 'ai_error' : 'ai_invalid_output';
    const pseudoConfidence = 0.3; // no real confidence signal when AI failed
    await enqueueGroupForReview(routedCase.settlements, context, reasonCode, exposureAmount, (1 - pseudoConfidence) * exposureAmount);
    return 'reviewed';
  }

  const classification = aiResult.classification!;

  if (routedCase.caseType === 'ambiguous_duplicate') {
    if (
      classification.classification === 'MATCH_FOUND' &&
      classification.selectedTokens.length === 1 &&
      classification.confidence >= AI_AUTO_RESOLVE_CONFIDENCE_THRESHOLD
    ) {
      const [winnerSettlementId] = resolveTokens(tokenToSettlementId, aiResult);

      await finalizeCase({
        settlementIds: [winnerSettlementId],
        ledgerOrderId: routedCase.order!.id,
        finalStatus: 'matched',
        decidedBy: 'post_ai',
        matchCandidateId: matchCandidateIdFor(winnerSettlementId, context),
        aiInvestigationId,
        evidenceVersion: EVIDENCE_VERSION,
        evidence: { classification, winnerSettlementId },
        reasonCode: 'ai_investigation_confident_match',
      });

      // Every OTHER tied settlement gets a terminal decision too - never
      // left dangling with no resolution at all.
      const losers = routedCase.settlements.filter((s) => s.id !== winnerSettlementId);
      for (const loser of losers) {
        await finalizeCase({
          settlementIds: [loser.id],
          ledgerOrderId: null,
          finalStatus: 'rejected',
          decidedBy: 'post_ai',
          matchCandidateId: matchCandidateIdFor(loser.id, context),
          aiInvestigationId,
          evidenceVersion: EVIDENCE_VERSION,
          evidence: { classification, winnerSettlementId, loserSettlementId: loser.id },
          reasonCode: 'lost_ambiguous_duplicate_tiebreak',
        });
      }

      return 'finalized';
    }

    if (classification.classification === 'MULTIPLE_MATCH_FOUND') {
      // Semantically invalid: a duplicate-tie has exactly one winner, never
      // multiple. Logged loudly - may indicate a prompt-design issue worth
      // revisiting, not just routed silently.
      console.warn(
        `⚠️  routingPolicy: AI returned MULTIPLE_MATCH_FOUND for an ambiguous_duplicate case ` +
          `(match_candidate ${primaryMatchCandidateId}) - a duplicate tie has exactly one winner, never multiple. ` +
          'Routed to review_queue instead of auto-resolving; consider revisiting the investigation prompt.',
      );
      await enqueueGroupForReview(
        routedCase.settlements,
        context,
        'ai_returned_invalid_combination_for_case_type',
        exposureAmount,
        (1 - classification.confidence) * exposureAmount,
      );
      return 'reviewed';
    }

    // Any other combination: NO_VIABLE_MATCH, INSUFFICIENT_EVIDENCE, or
    // MATCH_FOUND below the confidence threshold (or with an unexpected
    // token count). Trust the AI's own confidence for review prioritization
    // here - it's a legitimate signal when we're only ranking review
    // urgency, not auto-finalizing.
    await enqueueGroupForReview(
      routedCase.settlements,
      context,
      `ai_classification_${classification.classification.toLowerCase()}`,
      exposureAmount,
      (1 - classification.confidence) * exposureAmount,
    );
    return 'reviewed';
  }

  // routedCase.caseType === 'split_payment_ambiguous'
  if (classification.classification === 'MULTIPLE_MATCH_FOUND' && classification.confidence >= AI_AUTO_RESOLVE_CONFIDENCE_THRESHOLD) {
    const settlementIds = resolveTokens(tokenToSettlementId, aiResult);
    await finalizeCase({
      settlementIds,
      ledgerOrderId: routedCase.order!.id,
      finalStatus: 'matched',
      decidedBy: 'post_ai',
      matchCandidateId: matchCandidateIdFor(settlementIds[0], context),
      aiInvestigationId,
      evidenceVersion: EVIDENCE_VERSION,
      evidence: { classification, settlementIds },
      reasonCode: 'ai_confirmed_split_payment_subset',
    });
    return 'finalized';
  }

  // Everything else - NO_VIABLE_MATCH, INSUFFICIENT_EVIDENCE, MATCH_FOUND
  // (not a semantically expected outcome for a multi-leg split, but not
  // called out as an "invalid combination" the way ambiguous_duplicate's
  // MULTIPLE_MATCH_FOUND is either - treated as the same generic fallback),
  // or MULTIPLE_MATCH_FOUND below the confidence threshold.
  await enqueueGroupForReview(
    routedCase.settlements,
    context,
    `ai_classification_${classification.classification.toLowerCase()}`,
    exposureAmount,
    (1 - classification.confidence) * exposureAmount,
  );
  return 'reviewed';
}
