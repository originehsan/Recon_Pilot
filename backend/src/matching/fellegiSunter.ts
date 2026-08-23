// Stage 6: Fellegi-Sunter probabilistic record-linkage scoring over Stage 4's
// scored residual candidates.
//
// Only two features are used: string similarity and amount delta. A
// date-based feature is intentionally excluded, not just zero-weighted -
// the Settlement interface has no date field (see types.ts), so
// CandidatePair.dateDeltaDays is always null in the current schema and
// carries zero information. Including a feature that's always null would
// either need to be silently ignored (misleading) or would corrupt the
// bin counts, neither of which is acceptable.

import { LabeledCandidate } from './buildTrainingLabels';
import { CandidatePair } from './types';

export type SimilarityBin = 'HIGH' | 'MEDIUM' | 'LOW';

export function binStringSimilarity(sim: number): SimilarityBin {
  if (sim >= 0.85) return 'HIGH';
  if (sim >= 0.6) return 'MEDIUM';
  return 'LOW';
}

export type AmountBin = 'EXACT' | 'CLOSE' | 'FAR';

export function binAmountDelta(absDelta: number): AmountBin {
  if (absDelta <= 5) return 'EXACT';
  if (absDelta <= 1000) return 'CLOSE';
  return 'FAR';
}

const SIMILARITY_BINS: SimilarityBin[] = ['HIGH', 'MEDIUM', 'LOW'];
const AMOUNT_BINS: AmountBin[] = ['EXACT', 'CLOSE', 'FAR'];

export interface FSParameters {
  stringSimilarity: Record<SimilarityBin, { m: number; u: number }>;
  amountDelta: Record<AmountBin, { m: number; u: number }>;
}

/** stringSimilarity must already be populated by Stage 4 before scoring/estimation. */
function requireSimilarity(candidate: CandidatePair): number {
  if (candidate.stringSimilarity === null) {
    throw new Error(
      'fellegiSunter: candidate.stringSimilarity is null - run Stage 4 (scoreResidualCandidates) first.',
    );
  }
  return candidate.stringSimilarity;
}

function countByBin<Bin extends string>(
  candidates: LabeledCandidate[],
  bins: readonly Bin[],
  binOf: (candidate: LabeledCandidate) => Bin,
): Record<Bin, number> {
  const counts = {} as Record<Bin, number>;
  for (const bin of bins) counts[bin] = 0;
  for (const candidate of candidates) {
    counts[binOf(candidate)]++;
  }
  return counts;
}

/**
 * Laplace (add-1) smoothed m/u estimates for one feature's bins:
 *   m = (true-match count in bin + 1) / (total true-match count + bin count)
 *   u = (non-match count in bin + 1) / (total non-match count + bin count)
 * Add-1 smoothing guarantees no bin ever gets m=0 or u=0 just because it
 * happened to have zero observations in the training set - a zero would
 * make the log-likelihood ratio in scoreCandidateFS undefined (log2(0) or
 * division by zero).
 */
function estimateBinParams<Bin extends string>(
  trueMatches: LabeledCandidate[],
  nonMatches: LabeledCandidate[],
  bins: readonly Bin[],
  binOf: (candidate: LabeledCandidate) => Bin,
): Record<Bin, { m: number; u: number }> {
  const numBins = bins.length;
  const trueCounts = countByBin(trueMatches, bins, binOf);
  const nonCounts = countByBin(nonMatches, bins, binOf);

  const result = {} as Record<Bin, { m: number; u: number }>;
  for (const bin of bins) {
    const m = (trueCounts[bin] + 1) / (trueMatches.length + numBins);
    const u = (nonCounts[bin] + 1) / (nonMatches.length + numBins);
    result[bin] = { m, u };
  }
  return result;
}

export function estimateFSParameters(labeledCandidates: LabeledCandidate[]): FSParameters {
  const trueMatches = labeledCandidates.filter((c) => c.isTrueMatch);
  const nonMatches = labeledCandidates.filter((c) => !c.isTrueMatch);

  const stringSimilarity = estimateBinParams(trueMatches, nonMatches, SIMILARITY_BINS, (c) =>
    binStringSimilarity(requireSimilarity(c)),
  );

  const amountDelta = estimateBinParams(trueMatches, nonMatches, AMOUNT_BINS, (c) =>
    binAmountDelta(Math.abs(c.amountDelta)),
  );

  return { stringSimilarity, amountDelta };
}

/**
 * FS score = sum of per-feature log2 likelihood ratios (m/u). Positive means
 * the evidence favors a true match, negative favors a non-match.
 */
export function scoreCandidateFS(candidate: CandidatePair, params: FSParameters): number {
  const simBin = binStringSimilarity(requireSimilarity(candidate));
  const amountBin = binAmountDelta(Math.abs(candidate.amountDelta));

  const simParams = params.stringSimilarity[simBin];
  const amountParams = params.amountDelta[amountBin];

  return Math.log2(simParams.m / simParams.u) + Math.log2(amountParams.m / amountParams.u);
}
