// Standalone held-out evaluation script - NOT part of the production path.
//
//   npm run verify-holdout
//
// runFullPipeline.ts (and therefore POST /api/runs, verify-pipeline, and
// verify-decision-gate) always estimates Fellegi-Sunter parameters from the
// FULL labeled set - correct production practice, and unchanged by this
// file. What this script proves is that the resulting accuracy isn't
// circular: it estimates parameters from only a 70% training split, then
// scores the 30% test split the parameters never saw, and reports accuracy
// on both so the difference (or lack of one) is visible.
//
// This script only reads from the live seeded database. It never calls
// runFullPipeline, never writes to resolutions/review_queue/audit_events,
// and does not touch decisionGate/ at all.

import { loadSettlementsAndOrders } from './dbLoader';
import { loadGroundTruth } from './groundTruth';
import { runExactMatch } from './exactMatch';
import { generateResidualCandidates } from './residualCandidates';
import { scoreResidualCandidates } from './scoreResidualCandidates';
import { labelResidualCandidates, LabeledCandidate } from './buildTrainingLabels';
import { estimateFSParameters, scoreCandidateFS, FSParameters } from './fellegiSunter';
import { calibrateThresholds } from './calibrateThresholds';
import { splitLabeledCandidates } from './evaluationSplit';

// Fixed, documented seed - anyone re-running this script gets the exact same
// 70/30 split over the same labeled set, so the reported numbers reproduce.
const HOLDOUT_SEED = 42;
const TRAIN_RATIO = 0.7;

interface Metrics {
  total: number;
  truePositives: number;
  trueNegatives: number;
  falsePositives: number;
  falseNegatives: number;
}

function classify(candidate: LabeledCandidate, params: FSParameters, upperThreshold: number): boolean {
  return scoreCandidateFS(candidate, params) >= upperThreshold;
}

/**
 * Accuracy/precision/recall of `params` + `upperThreshold` (the auto-resolve
 * bar) against `candidates`' actual ground-truth labels. "Predicted match"
 * here means "would clear the auto-resolve bar", the same bar
 * calibrateThresholds computes for the real pipeline.
 */
function scoreAgainst(candidates: LabeledCandidate[], params: FSParameters, upperThreshold: number): Metrics {
  let truePositives = 0;
  let trueNegatives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const candidate of candidates) {
    const predictedMatch = classify(candidate, params, upperThreshold);
    if (predictedMatch && candidate.isTrueMatch) truePositives++;
    else if (!predictedMatch && !candidate.isTrueMatch) trueNegatives++;
    else if (predictedMatch && !candidate.isTrueMatch) falsePositives++;
    else falseNegatives++;
  }

  return { total: candidates.length, truePositives, trueNegatives, falsePositives, falseNegatives };
}

function printMetrics(label: string, m: Metrics): void {
  const accuracy = m.total > 0 ? ((m.truePositives + m.trueNegatives) / m.total) * 100 : NaN;
  const precision =
    m.truePositives + m.falsePositives > 0 ? (m.truePositives / (m.truePositives + m.falsePositives)) * 100 : NaN;
  const recall = m.truePositives + m.falseNegatives > 0 ? (m.truePositives / (m.truePositives + m.falseNegatives)) * 100 : NaN;

  console.log(`\n${label}`);
  console.log(`  Candidates scored:  ${m.total}`);
  console.log(`  True positives:     ${m.truePositives}`);
  console.log(`  True negatives:     ${m.trueNegatives}`);
  console.log(`  False positives:    ${m.falsePositives}`);
  console.log(`  False negatives:    ${m.falseNegatives}`);
  console.log(`  Accuracy:           ${isNaN(accuracy) ? 'n/a (no candidates)' : accuracy.toFixed(2) + '%'}`);
  console.log(`  Precision:          ${isNaN(precision) ? 'n/a (no predicted matches)' : precision.toFixed(2) + '%'}`);
  console.log(`  Recall:             ${isNaN(recall) ? 'n/a (no actual matches)' : recall.toFixed(2) + '%'}`);
}

async function main(): Promise<void> {
  console.log('Loading settlements, ledger orders, and ground truth...');
  const { settlements, orders } = await loadSettlementsAndOrders();
  const groundTruth = loadGroundTruth();

  // Same Stage 1/2/4 pipeline steps runFullPipeline.ts uses to build the
  // labeled candidate set - this script does not call runFullPipeline
  // itself (it has no holdout hook, by design: production is not touched).
  const stage1 = runExactMatch(settlements, orders);
  const residualCandidates = generateResidualCandidates(stage1.noOrderIdMatch, stage1.unmatchedOrders);
  const scoredResidualCandidates = scoreResidualCandidates(residualCandidates);
  const labeledCandidates = labelResidualCandidates(scoredResidualCandidates, groundTruth);

  console.log(`Loaded ${labeledCandidates.length} labeled residual candidate(s).`);

  // -------------------------------------------------------------------
  // The old, circular way: estimate on everything, score on everything.
  // Printed purely as a comparison point - this script does not use it to
  // report the headline number.
  // -------------------------------------------------------------------
  const fullParams = estimateFSParameters(labeledCandidates);
  const fullThresholds = calibrateThresholds(labeledCandidates, fullParams);
  const fullMetrics = scoreAgainst(labeledCandidates, fullParams, fullThresholds.upper);

  // -------------------------------------------------------------------
  // The held-out way: estimate on 70% (seed=42), score on the 30% never
  // used for estimation.
  // -------------------------------------------------------------------
  const { train, test } = splitLabeledCandidates(labeledCandidates, TRAIN_RATIO, HOLDOUT_SEED);
  const trainParams = estimateFSParameters(train);
  const trainThresholds = calibrateThresholds(train, trainParams);
  const holdoutMetrics = scoreAgainst(test, trainParams, trainThresholds.upper);

  const holdoutAccuracy =
    holdoutMetrics.total > 0
      ? ((holdoutMetrics.truePositives + holdoutMetrics.trueNegatives) / holdoutMetrics.total) * 100
      : NaN;

  console.log(
    `\nTrained on ${train.length} candidates (${Math.round(TRAIN_RATIO * 100)}%), evaluated on ${test.length} ` +
      `candidates (${Math.round((1 - TRAIN_RATIO) * 100)}%, never seen during training). ` +
      `Accuracy on held-out set: ${isNaN(holdoutAccuracy) ? 'n/a' : holdoutAccuracy.toFixed(2) + '%'}.`,
  );

  printMetrics(`=== Held-out evaluation (seed=${HOLDOUT_SEED}, train ${Math.round(TRAIN_RATIO * 100)}% / test ${Math.round((1 - TRAIN_RATIO) * 100)}%) ===`, holdoutMetrics);
  printMetrics('=== Full-dataset evaluation (old, circular way - estimate and score on everything) ===', fullMetrics);
}

main().catch((err) => {
  console.error('❌ verify-holdout failed:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
