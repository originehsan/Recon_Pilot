// Standalone ablation-study script - NOT part of the production path.
//
//   npm run verify-ablation             (real Gemini calls - see --dry-run below)
//   npm run verify-ablation -- --dry-run  (no network calls, just reports the
//                                          ai_investigation case count)
//
// Compares two scenarios against the live seeded dataset's ground truth:
//
//   "Deterministic-only": what the system would resolve with the AI
//   investigation stage removed entirely - every ai_investigation-routed
//   case (and every human_review case, which never involved AI to begin
//   with) is left unresolved.
//
//   "Deterministic+AI": the real current system behavior - the same
//   auto_resolve outcomes, PLUS whatever the AI investigation stage
//   actually resolves for ai_investigation-routed cases, using the REAL
//   Gemini client.
//
// READ-ONLY BY DESIGN: this script never calls orchestrateBatch (which
// writes match_candidates/resolutions/review_queue unconditionally for
// every case - see this file's Step 0 audit) or finalizeCase/
// enqueueForReview directly. For ai_investigation-routed cases, it calls the
// real investigate() (confirmed to have zero DB dependency - see
// aiInvestigation/investigate.ts) and then mirrors routeAfterAIInvestigation's
// classification-to-outcome decision rules ENTIRELY IN MEMORY, reusing the
// same exported AI_AUTO_RESOLVE_CONFIDENCE_THRESHOLD constant and the same
// resolveTokens() helper routingPolicy.ts itself uses, so this mirror can't
// silently drift on the one number that matters most. If routingPolicy.ts's
// decision rules are ever restructured, this mirror needs a matching update -
// that coupling is disclosed here, not hidden.
//
// Nothing in this script writes to resolutions, review_queue,
// match_candidates, ai_investigations, or audit_events.

import { loadSettlementsAndOrders } from '../matching/dbLoader';
import { loadGroundTruth, GroundTruthEntry } from '../matching/groundTruth';
import { runFullPipeline } from '../matching/runFullPipeline';
import { RoutedCase } from '../matching/thresholdGate';
import { buildEvidenceBundle } from '../aiInvestigation/evidenceBundle';
import { investigate, AIInvestigationResult } from '../aiInvestigation/investigate';
import { resolveTokens } from '../aiInvestigation/resolveTokens';
import { AI_AUTO_RESOLVE_CONFIDENCE_THRESHOLD } from './routingPolicy';

// Same free-tier pacing established live in aiInvestigation/manualVerify.ts
// (5 requests/minute for gemini-3.6-flash).
const MIN_MS_BETWEEN_CALLS = 13_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDryRunFlag(argv: string[]): boolean {
  return argv.includes('--dry-run');
}

type SettlementOutcome = 'matched' | 'rejected' | 'unresolved';

interface SettlementResult {
  settlementId: number;
  entityId: string;
  outcome: SettlementOutcome;
  matchedOrderId: string | null; // set only when outcome === 'matched'
}

interface ScenarioMetrics {
  total: number;
  resolved: number;
  correct: number;
  coverage: number; // % resolved (matched or rejected) out of total
  precision: number; // % of resolved that were correct per ground truth
  reviewRate: number; // % unresolved out of total
}

/**
 * Ground truth correctness for one settlement's outcome:
 *   - matched: correct iff it was matched to its true order.
 *   - rejected: correct iff ground truth confirms it is NOT the genuine
 *     candidate for its case (isTrueCandidate === false - only meaningful
 *     for AMBIGUOUS_DUPLICATE, the only category that ever produces a
 *     'rejected' outcome in this pipeline).
 *   - unresolved: not judged (excluded from precision, the same way the
 *     prompt's spec defines it).
 */
function isCorrect(
  result: SettlementResult,
  entityIdToTrueOrderId: Map<string, string>,
  entityIdToIsTrueCandidate: Map<string, boolean | null>,
): boolean {
  if (result.outcome === 'matched') {
    return entityIdToTrueOrderId.get(result.entityId) === result.matchedOrderId;
  }
  if (result.outcome === 'rejected') {
    return entityIdToIsTrueCandidate.get(result.entityId) === false;
  }
  return false; // unresolved is never "correct" - callers must exclude it before counting
}

function computeMetrics(
  results: SettlementResult[],
  entityIdToTrueOrderId: Map<string, string>,
  entityIdToIsTrueCandidate: Map<string, boolean | null>,
): ScenarioMetrics {
  const total = results.length;
  const resolvedResults = results.filter((r) => r.outcome !== 'unresolved');
  const resolved = resolvedResults.length;
  const correct = resolvedResults.filter((r) => isCorrect(r, entityIdToTrueOrderId, entityIdToIsTrueCandidate)).length;

  return {
    total,
    resolved,
    correct,
    coverage: total > 0 ? (resolved / total) * 100 : NaN,
    precision: resolved > 0 ? (correct / resolved) * 100 : NaN,
    reviewRate: total > 0 ? ((total - resolved) / total) * 100 : NaN,
  };
}

function pct(value: number): string {
  return isNaN(value) ? 'n/a' : `${value.toFixed(1)}%`;
}

/** Deterministic-only: every auto_resolve case matches; everything else (human_review, ai_investigation) is unresolved. */
function buildDeterministicOnlyResults(routedCases: RoutedCase[]): SettlementResult[] {
  const results: SettlementResult[] = [];
  for (const routedCase of routedCases) {
    for (const settlement of routedCase.settlements) {
      results.push({
        settlementId: settlement.id,
        entityId: settlement.entityId,
        outcome: routedCase.route === 'auto_resolve' ? 'matched' : 'unresolved',
        matchedOrderId: routedCase.route === 'auto_resolve' ? routedCase.order!.orderId : null,
      });
    }
  }
  return results;
}

/**
 * Mirrors routeAfterAIInvestigation's decision rules for ONE ai_investigation
 * case, given a real AIInvestigationResult, WITHOUT calling finalizeCase or
 * enqueueForReview (no writes). See this file's header comment.
 */
function determineAIOutcomes(
  routedCase: RoutedCase,
  aiResult: AIInvestigationResult,
  tokenToSettlementId: Map<string, number>,
): SettlementResult[] {
  const toUnresolved = (): SettlementResult[] =>
    routedCase.settlements.map((s) => ({
      settlementId: s.id,
      entityId: s.entityId,
      outcome: 'unresolved' as const,
      matchedOrderId: null,
    }));

  if (routedCase.caseType === 'residual_no_match') {
    // ALWAYS review_queue in production - see routingPolicy.ts.
    return toUnresolved();
  }

  if (aiResult.status !== 'success') {
    return toUnresolved();
  }

  const classification = aiResult.classification!;

  if (routedCase.caseType === 'ambiguous_duplicate') {
    if (
      classification.classification === 'MATCH_FOUND' &&
      classification.selectedTokens.length === 1 &&
      classification.confidence >= AI_AUTO_RESOLVE_CONFIDENCE_THRESHOLD
    ) {
      const [winnerSettlementId] = resolveTokens(tokenToSettlementId, aiResult);
      return routedCase.settlements.map((s) => ({
        settlementId: s.id,
        entityId: s.entityId,
        outcome: s.id === winnerSettlementId ? 'matched' : 'rejected',
        matchedOrderId: s.id === winnerSettlementId ? routedCase.order!.orderId : null,
      }));
    }
    return toUnresolved();
  }

  // routedCase.caseType === 'split_payment_ambiguous'
  if (classification.classification === 'MULTIPLE_MATCH_FOUND' && classification.confidence >= AI_AUTO_RESOLVE_CONFIDENCE_THRESHOLD) {
    const settlementIds = new Set(resolveTokens(tokenToSettlementId, aiResult));
    return routedCase.settlements.map((s) => ({
      settlementId: s.id,
      entityId: s.entityId,
      outcome: settlementIds.has(s.id) ? 'matched' : 'unresolved',
      matchedOrderId: settlementIds.has(s.id) ? routedCase.order!.orderId : null,
    }));
  }
  return toUnresolved();
}

async function main(): Promise<void> {
  const dryRun = parseDryRunFlag(process.argv.slice(2));

  console.log('Loading settlements, ledger orders, and ground truth...');
  const { settlements, orders } = await loadSettlementsAndOrders();
  const groundTruth = loadGroundTruth();

  console.log('Running the full pipeline (Stages 0-7)...\n');
  const { routedCases } = runFullPipeline(settlements, orders, groundTruth);

  const aiCases = routedCases.filter((c) => c.route === 'ai_investigation');
  const totalSettlements = routedCases.reduce((sum, c) => sum + c.settlements.length, 0);

  console.log(`Loaded ${totalSettlements} settlement(s) across ${routedCases.length} routed case(s).`);
  console.log(`${aiCases.length} case(s) are routed to ai_investigation - each makes ONE real Gemini API call.`);

  if (dryRun) {
    console.log(
      `\n--dry-run passed: no Gemini calls made. Re-run without --dry-run to execute ` +
        `${aiCases.length} real API call(s), paced ${MIN_MS_BETWEEN_CALLS / 1000}s apart.`,
    );
    return;
  }

  const entityIdToTrueOrderId = new Map<string, string>();
  const entityIdToIsTrueCandidate = new Map<string, boolean | null>();
  for (const entry of groundTruth as GroundTruthEntry[]) {
    if (entry.entity_id !== null) {
      entityIdToTrueOrderId.set(entry.entity_id, entry.order_id);
      entityIdToIsTrueCandidate.set(entry.entity_id, entry.isTrueCandidate);
    }
  }

  // -----------------------------------------------------------------------
  // Scenario 1: Deterministic-only.
  // -----------------------------------------------------------------------
  const deterministicOnlyResults = buildDeterministicOnlyResults(routedCases);

  // -----------------------------------------------------------------------
  // Scenario 2: Deterministic+AI (the real current system behavior).
  // Same auto_resolve/human_review outcomes as above, plus a REAL Gemini
  // call per ai_investigation case.
  // -----------------------------------------------------------------------
  const deterministicPlusAiResults: SettlementResult[] = [];
  for (const routedCase of routedCases) {
    if (routedCase.route !== 'ai_investigation') {
      // Identical to the deterministic-only outcome for every non-AI route.
      for (const settlement of routedCase.settlements) {
        deterministicPlusAiResults.push({
          settlementId: settlement.id,
          entityId: settlement.entityId,
          outcome: routedCase.route === 'auto_resolve' ? 'matched' : 'unresolved',
          matchedOrderId: routedCase.route === 'auto_resolve' ? routedCase.order!.orderId : null,
        });
      }
      continue;
    }

    const callIndex = aiCases.indexOf(routedCase);
    if (callIndex > 0) {
      console.log(`(pacing ${MIN_MS_BETWEEN_CALLS / 1000}s before the next Gemini call...)`);
      await sleep(MIN_MS_BETWEEN_CALLS);
    }

    const { bundle, tokenToSettlementId } = buildEvidenceBundle(routedCase);
    console.log(`\nInvestigating case ${callIndex + 1}/${aiCases.length} (caseType: ${routedCase.caseType})...`);
    const aiResult = await investigate(bundle); // REAL Gemini API call - not mocked
    console.log(`  status: ${aiResult.status}${aiResult.classification ? `, classification: ${aiResult.classification.classification}, confidence: ${aiResult.classification.confidence}` : ''}`);

    const outcomes = determineAIOutcomes(routedCase, aiResult, tokenToSettlementId);
    deterministicPlusAiResults.push(...outcomes);
  }

  // -----------------------------------------------------------------------
  // Metrics + report.
  // -----------------------------------------------------------------------
  const detOnlyMetrics = computeMetrics(deterministicOnlyResults, entityIdToTrueOrderId, entityIdToIsTrueCandidate);
  const detAiMetrics = computeMetrics(deterministicPlusAiResults, entityIdToTrueOrderId, entityIdToIsTrueCandidate);

  console.log('\n=== Ablation: Deterministic-only vs Deterministic+AI ===');
  console.log(`${''.padEnd(28)}${'Deterministic-only'.padEnd(22)}${'Deterministic+AI'.padEnd(20)}`);
  console.log(`${'Coverage (auto-resolved)'.padEnd(28)}${pct(detOnlyMetrics.coverage).padEnd(22)}${pct(detAiMetrics.coverage).padEnd(20)}`);
  console.log(`${'Precision'.padEnd(28)}${pct(detOnlyMetrics.precision).padEnd(22)}${pct(detAiMetrics.precision).padEnd(20)}`);
  console.log(`${'Needs human review'.padEnd(28)}${pct(detOnlyMetrics.reviewRate).padEnd(22)}${pct(detAiMetrics.reviewRate).padEnd(20)}`);

  // N = settlements unresolved in deterministic-only that became correctly
  // resolved (matched or rejected) once AI investigation ran.
  const detOnlyBySettlementId = new Map(deterministicOnlyResults.map((r) => [r.settlementId, r]));
  let additionalCorrect = 0;
  for (const r of deterministicPlusAiResults) {
    const before = detOnlyBySettlementId.get(r.settlementId);
    if (
      before?.outcome === 'unresolved' &&
      r.outcome !== 'unresolved' &&
      isCorrect(r, entityIdToTrueOrderId, entityIdToIsTrueCandidate)
    ) {
      additionalCorrect++;
    }
  }

  console.log(
    `\nAI investigation resolved ${additionalCorrect} additional case(s) correctly that deterministic\n` +
      'matching alone could not (N = count of cases correctly resolved in the\n' +
      "Deterministic+AI set that were 'unresolved' in the Deterministic-only set).",
  );

  console.log(
    `\n(Raw counts - Deterministic-only: ${detOnlyMetrics.resolved}/${detOnlyMetrics.total} resolved, ` +
      `${detOnlyMetrics.correct} correct. Deterministic+AI: ${detAiMetrics.resolved}/${detAiMetrics.total} resolved, ` +
      `${detAiMetrics.correct} correct.)`,
  );
}

main().catch((err) => {
  console.error('❌ verify-ablation failed:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
