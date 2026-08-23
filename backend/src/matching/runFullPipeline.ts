// Wires Stages 0-7 together: raw settlements/orders in, final routing
// decisions out. No AI calls, no decision-gate finalization, no audit
// logging - `ai_investigation` here is only a routing label.

import { runExactMatch } from './exactMatch';
import { generateResidualCandidates } from './residualCandidates';
import { scoreResidualCandidates } from './scoreResidualCandidates';
import { detectSplitPayments } from './splitPaymentDetector';
import { labelResidualCandidates } from './buildTrainingLabels';
import { GroundTruthEntry } from './groundTruth';
import { estimateFSParameters, scoreCandidateFS } from './fellegiSunter';
import { calibrateThresholds } from './calibrateThresholds';
import { findAmbiguityComponents } from './ambiguityComponents';
import { assignComponent, AssignmentResult } from './hungarianAssignment';
import { routeAllCases, RoutedCase } from './thresholdGate';
import { Thresholds } from './calibrateThresholds';
import { LedgerOrder, Settlement } from './types';

export interface FullPipelineResult {
  routedCases: RoutedCase[];
  /**
   * The calibrated auto-resolve/review thresholds computed internally
   * (Step 3). Exposed because decisionGate/routingPolicy.ts's human_review
   * priority scoring needs the same upper/lower bounds the pipeline itself
   * used to route cases into that band - re-deriving them independently
   * would risk drifting out of sync with what actually produced this
   * result, and would recompute the whole labeling/calibration pass for no
   * reason (this pipeline is a pure function of its inputs).
   */
  thresholds: Thresholds;
}

/**
 * Runs the full deterministic matching pipeline (Stages 0-7) and returns the
 * final routed cases plus the thresholds used to produce them.
 *
 * `groundTruth` is used only to LABEL residual candidates for Fellegi-Sunter
 * parameter estimation and threshold calibration (Steps 1-3) - it is
 * training data for this offline/demo pipeline, not something a real
 * production system would have at inference time. See buildTrainingLabels.ts
 * for why the full labeled set doubles as both the training set and the
 * verification set here.
 */
export function runFullPipeline(
  settlements: Settlement[],
  orders: LedgerOrder[],
  groundTruth: GroundTruthEntry[],
): FullPipelineResult {
  // Stage 1: exact hash-join match + amount reconciliation.
  const stage1 = runExactMatch(settlements, orders);

  // Stage 2: full residual candidate set over Stage 1's leftovers only.
  const residualCandidates = generateResidualCandidates(stage1.noOrderIdMatch, stage1.unmatchedOrders);

  // Stage 4: string-similarity scoring of every residual candidate.
  const scoredResidualCandidates = scoreResidualCandidates(residualCandidates);

  // Stage 3: exact subset-sum split-payment detection over Stage 1's amount mismatches.
  const splitPaymentResults = detectSplitPayments(stage1.amountMismatches);

  // Step 1: label residual candidates against ground truth (training data for FS).
  const labeledCandidates = labelResidualCandidates(scoredResidualCandidates, groundTruth);

  // Step 2: estimate Fellegi-Sunter m/u parameters from the labeled set.
  const fsParams = estimateFSParameters(labeledCandidates);

  // Step 3: calibrate the auto-resolve/review thresholds from the same labeled set.
  const thresholds = calibrateThresholds(labeledCandidates, fsParams);

  // Score every residual candidate (not just the labeled ones used for
  // calibration - see buildTrainingLabels.ts, they're the same full set here)
  // with the fitted FS parameters for use in component detection/assignment.
  const scoredWithFS = scoredResidualCandidates.map((candidate) => ({
    ...candidate,
    fsScore: scoreCandidateFS(candidate, fsParams),
  }));

  // Step 4: connected-component detection over candidates clearing the lower threshold.
  const components = findAmbiguityComponents(scoredWithFS, thresholds.lower);

  // Step 5: Hungarian assignment within each component.
  const hungarianResults: AssignmentResult[] = components.flatMap((component) => assignComponent(component));

  // Settlements that never qualified for ANY component (every one of their
  // candidate pairs scored below lowerThreshold) never reach Hungarian at
  // all - Step 4's note explicitly says this case is "handled separately in
  // Step 6". Give them the same outcome as a dummy assignment: no viable
  // candidate.
  const settlementIdsInComponents = new Set(components.flatMap((c) => c.settlements.map((s) => s.id)));
  const orphanResults: AssignmentResult[] = stage1.noOrderIdMatch
    .filter((settlement) => !settlementIdsInComponents.has(settlement.id))
    .map((settlement) => ({ settlement, order: null, fsScore: null }));

  // Step 6: final routing.
  const routedCases = routeAllCases(
    stage1.exactMatches,
    stage1.ambiguousExactDuplicates,
    splitPaymentResults,
    [...hungarianResults, ...orphanResults],
    thresholds,
  );

  return { routedCases, thresholds };
}
