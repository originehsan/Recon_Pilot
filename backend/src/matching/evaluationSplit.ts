// Held-out evaluation support - NOT part of the production estimation path.
//
// runFullPipeline.ts (and therefore POST /api/runs) intentionally estimates
// Fellegi-Sunter parameters from the FULL labeled set every run - that's
// correct production practice (more labeled data -> better-calibrated
// parameters) and this file does not change that.
//
// What this file adds is a deterministic train/test split so a *separate*
// verification script (verifyHoldoutAccuracy.ts) can prove the pipeline's
// reported accuracy isn't circular: estimate on 70%, score on the 30% the
// parameters never saw.

import { LabeledCandidate } from './buildTrainingLabels';

/**
 * Deterministic PRNG (mulberry32) - same seed always produces the same
 * sequence, so the same seed always produces the same split. Not
 * cryptographically strong, and doesn't need to be; only reproducibility
 * matters here.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LabeledCandidateSplit {
  train: LabeledCandidate[];
  test: LabeledCandidate[];
}

/**
 * Deterministically shuffles `labeledCandidates` (Fisher-Yates, seeded by
 * `mulberry32(seed)`) and splits it into a train subset (the first
 * `trainRatio` fraction, rounded to the nearest candidate) and a test
 * subset (the remainder). Every candidate appears in exactly one of the two
 * output arrays.
 */
export function splitLabeledCandidates(
  labeledCandidates: LabeledCandidate[],
  trainRatio: number = 0.7,
  seed: number,
): LabeledCandidateSplit {
  const rng = mulberry32(seed);

  const shuffled = [...labeledCandidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const trainSize = Math.round(shuffled.length * trainRatio);
  const train = shuffled.slice(0, trainSize);
  const test = shuffled.slice(trainSize);

  return { train, test };
}
