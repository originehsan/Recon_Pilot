// Threshold calibration: turn the labeled training set's actual FS score
// distribution into an `upper` (auto-resolve) and `lower` (still worth a
// human look) boundary, rather than picking arbitrary constants.

import { LabeledCandidate } from './buildTrainingLabels';
import { FSParameters, scoreCandidateFS } from './fellegiSunter';

export interface Thresholds {
  upper: number;
  lower: number;
}

// Below this many true-match examples, a data-driven boundary is
// statistically meaningless (a single outlier could set the whole
// auto-resolve bar).
const MIN_TRUE_MATCHES_FOR_CALIBRATION = 3;

const FALLBACK_THRESHOLDS: Thresholds = { upper: 5.0, lower: 0.0 };

export function calibrateThresholds(labeledCandidates: LabeledCandidate[], params: FSParameters): Thresholds {
  const scored = labeledCandidates.map((candidate) => ({
    candidate,
    fsScore: scoreCandidateFS(candidate, params),
  }));

  const trueMatchScores = scored.filter((s) => s.candidate.isTrueMatch).map((s) => s.fsScore);
  const nonMatchScores = scored.filter((s) => !s.candidate.isTrueMatch).map((s) => s.fsScore);

  if (trueMatchScores.length < MIN_TRUE_MATCHES_FOR_CALIBRATION) {
    console.warn(
      `⚠️  calibrateThresholds: only ${trueMatchScores.length} true-match candidate(s) in the labeled ` +
        `training set (need at least ${MIN_TRUE_MATCHES_FOR_CALIBRATION} for a statistically meaningful ` +
        `calibration). Falling back to upper=${FALLBACK_THRESHOLDS.upper}, lower=${FALLBACK_THRESHOLDS.lower}.`,
    );
    return { ...FALLBACK_THRESHOLDS };
  }

  // Every true match in training data must clear the auto-resolve bar, so the
  // bar is exactly the worst (minimum) true-match score - no arbitrary safety
  // margin added on top.
  const upper = Math.min(...trueMatchScores);

  // The review band's floor is the highest-scoring non-match that still fell
  // short of auto-resolve - i.e. the most convincing wrong answer the training
  // data produced. Anything at or below that score is exactly as suspicious
  // as a known non-match and should never be auto-resolved or silently
  // dropped from review.
  const nonMatchScoresBelowUpper = nonMatchScores.filter((score) => score < upper);
  const lower =
    nonMatchScoresBelowUpper.length > 0
      ? Math.max(...nonMatchScoresBelowUpper)
      : // No non-match scored below the auto-resolve bar at all - there's no
        // natural "just short of auto-resolve" boundary to anchor on, so the
        // review band collapses to empty (lower = upper) rather than guessing
        // one.
        upper;

  return { upper, lower };
}
