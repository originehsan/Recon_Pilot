// Standalone verification script.
//
//   npm run verify-decision-gate               (mocked AI, safe to run repeatedly)
//   npm run verify-decision-gate -- --real-ai   (REAL Gemini calls - sparse quota)
//
// Runs the full Stage 0-7 matching pipeline against the live DB, runs
// orchestrateBatch over the result, then cross-checks what actually got
// persisted against ground-truth.json.

import mysql from 'mysql2/promise';
import { loadSettlementsAndOrders } from '../matching/dbLoader';
import { loadGroundTruth } from '../matching/groundTruth';
import { runFullPipeline } from '../matching/runFullPipeline';
import { orchestrateBatch, InvestigateFn } from './orchestrate';
import { investigate } from '../aiInvestigation/investigate';
import { EvidenceBundle } from '../aiInvestigation/evidenceBundle';
import { AIInvestigationResult } from '../aiInvestigation/investigate';
import { getPool } from '../db/pool';

// Same free-tier pacing established live in aiInvestigation/manualVerify.ts
// (5 requests/minute for gemini-3.6-flash).
const REAL_AI_PACING_MS = 13_000;

function parseRealAiFlag(argv: string[]): boolean {
  return argv.includes('--real-ai');
}

/**
 * Safe default for repeated runs: makes no network call, and always returns
 * a legitimate (not fabricated-confident) INSUFFICIENT_EVIDENCE response -
 * so a mocked run can never accidentally auto-finalize a case via fake
 * confidence. Every AI-routed case lands in review_queue, which is exactly
 * what this script's "nothing disappears" check needs to exercise.
 */
const mockInvestigateFn: InvestigateFn = async (bundle: EvidenceBundle): Promise<AIInvestigationResult> => ({
  status: 'success',
  classification: {
    classification: 'INSUFFICIENT_EVIDENCE',
    selectedTokens: [],
    confidence: 0.2,
    explanation: `[MOCKED - no real Gemini call] caseType=${bundle.caseType}, ${bundle.candidates.length} candidate(s).`,
  },
  rawResponse: JSON.stringify({ mocked: true }),
  latencyMs: 0,
  errorMessage: null,
});

function createPacedRealInvestigateFn(): InvestigateFn {
  let callCount = 0;
  return async (bundle: EvidenceBundle): Promise<AIInvestigationResult> => {
    if (callCount > 0) {
      console.log(`(pacing ${REAL_AI_PACING_MS / 1000}s before the next real Gemini call...)`);
      await new Promise((resolve) => setTimeout(resolve, REAL_AI_PACING_MS));
    }
    callCount++;
    return investigate(bundle); // real Gemini client (default param)
  };
}

function printRow(label: string, expected: number, found: number): boolean {
  const pass = expected === found;
  const status = pass ? '✅ MATCH' : '❌ FAIL';
  console.log(`${label.padEnd(78)} expected: ${String(expected).padEnd(5)} found: ${String(found).padEnd(5)} ${status}`);
  return pass;
}

interface ResolutionRow extends mysql.RowDataPacket {
  id: number;
  settlement_id: number;
  ledger_order_id: number | null;
  final_status: string;
  decided_by: string;
}

interface MatchCandidateRow extends mysql.RowDataPacket {
  id: number;
  settlement_id: number;
}

interface ReviewQueueRow extends mysql.RowDataPacket {
  match_candidate_id: number | null;
}

async function main(): Promise<void> {
  const useRealAi = parseRealAiFlag(process.argv.slice(2));

  console.log('Loading settlements, ledger orders, and ground truth...');
  const { settlements, orders } = await loadSettlementsAndOrders();
  const groundTruth = loadGroundTruth();

  console.log('Running the full pipeline (Stages 0-7)...\n');
  const { routedCases, thresholds } = runFullPipeline(settlements, orders, groundTruth);

  console.log(`Running the decision gate over ${routedCases.length} routed case(s).`);
  console.log(
    useRealAi
      ? '⚠️  Using the REAL Gemini client (--real-ai passed) - this consumes free-tier quota.'
      : 'Using a MOCKED AI client (default) - no network calls, no quota consumed, safe to run repeatedly.\n',
  );

  const investigateFn = useRealAi ? createPacedRealInvestigateFn() : mockInvestigateFn;
  const summary = await orchestrateBatch(routedCases, investigateFn, thresholds);

  console.log('\n=== Orchestration summary ===');
  console.log(`Total resolved (finalized): ${summary.finalized}`);
  console.log(`Total in review:            ${summary.reviewQueued}`);
  console.log(`Total failed:               ${summary.failed}`);

  // -------------------------------------------------------------------
  // Ground-truth cross-checks - query the live DB for what was ACTUALLY
  // persisted (orchestrateBatch's return value is just aggregate counts).
  // -------------------------------------------------------------------
  const pool = getPool();

  const [resolutionRows] = await pool.query<ResolutionRow[]>(
    `SELECT r.* FROM resolutions r
     WHERE NOT EXISTS (SELECT 1 FROM resolutions r2 WHERE r2.supersedes_resolution_id = r.id)`,
  );
  const currentResolutionBySettlementId = new Map<number, ResolutionRow>();
  for (const row of resolutionRows) currentResolutionBySettlementId.set(row.settlement_id, row);

  const [matchCandidateRows] = await pool.query<MatchCandidateRow[]>('SELECT id, settlement_id FROM match_candidates');
  const matchCandidateIdsBySettlementId = new Map<number, number[]>();
  for (const row of matchCandidateRows) {
    const list = matchCandidateIdsBySettlementId.get(row.settlement_id) ?? [];
    list.push(row.id);
    matchCandidateIdsBySettlementId.set(row.settlement_id, list);
  }

  const [reviewQueueRows] = await pool.query<ReviewQueueRow[]>('SELECT match_candidate_id FROM review_queue');
  const matchCandidateIdsInReviewQueue = new Set(
    reviewQueueRows.map((r) => r.match_candidate_id).filter((id): id is number => id !== null),
  );

  const entityIdToCategory = new Map<string, string>();
  const entityIdToTrueOrderId = new Map<string, string>();
  const entityIdToIsTrueCandidate = new Map<string, boolean | null>();
  for (const entry of groundTruth) {
    if (entry.entity_id !== null) {
      entityIdToCategory.set(entry.entity_id, entry.category);
      entityIdToTrueOrderId.set(entry.entity_id, entry.order_id);
      entityIdToIsTrueCandidate.set(entry.entity_id, (entry as { isTrueCandidate?: boolean | null }).isTrueCandidate ?? null);
    }
  }

  const entityIdToSettlementId = new Map<string, number>();
  for (const settlement of settlements) entityIdToSettlementId.set(settlement.entityId, settlement.id);

  const orderIdByOrderRowId = new Map<number, string>();
  for (const order of orders) orderIdByOrderRowId.set(order.id, order.orderId);

  console.log('\n=== Ground truth cross-check ===');
  const results: boolean[] = [];

  // Check 1: CLEAN_EXACT, ON_HOLD, and correctly-recovered
  // CORRUPTED_TRUNCATED/SUBSTITUTED -> matched, to the correct order.
  {
    let total = 0;
    let ok = 0;
    for (const [entityId, category] of entityIdToCategory) {
      if (!['CLEAN_EXACT', 'ON_HOLD', 'CORRUPTED_TRUNCATED', 'CORRUPTED_SUBSTITUTED'].includes(category)) continue;
      const settlementId = entityIdToSettlementId.get(entityId);
      if (settlementId === undefined) continue;
      total++;

      const resolution = currentResolutionBySettlementId.get(settlementId);
      const trueOrderId = entityIdToTrueOrderId.get(entityId);
      if (resolution && resolution.final_status === 'matched' && resolution.ledger_order_id !== null) {
        const resolvedOrderId = orderIdByOrderRowId.get(resolution.ledger_order_id);
        if (resolvedOrderId === trueOrderId) ok++;
      }
    }
    results.push(printRow('CLEAN_EXACT/ON_HOLD/recovered-CORRUPTED settlements matched to the correct order', total, ok));
  }

  // Check 2: every SPLIT_PAYMENT settlement -> matched, via stage7_auto or post_ai.
  {
    const splitEntityIds = [...entityIdToCategory.entries()].filter(([, cat]) => cat === 'SPLIT_PAYMENT').map(([id]) => id);
    let ok = 0;
    for (const entityId of splitEntityIds) {
      const settlementId = entityIdToSettlementId.get(entityId);
      if (settlementId === undefined) continue;
      const resolution = currentResolutionBySettlementId.get(settlementId);
      if (resolution && resolution.final_status === 'matched' && (resolution.decided_by === 'stage7_auto' || resolution.decided_by === 'post_ai')) {
        ok++;
      }
    }
    results.push(printRow('SPLIT_PAYMENT settlements matched via stage7_auto/post_ai', splitEntityIds.length, ok));
  }

  // Check 3: every AMBIGUOUS_DUPLICATE settlement ended up SOMEWHERE
  // (resolutions or review_queue) - nothing silently disappeared.
  {
    const ambiguousEntityIds = [...entityIdToCategory.entries()].filter(([, cat]) => cat === 'AMBIGUOUS_DUPLICATE').map(([id]) => id);
    let ok = 0;
    let autoMatchedCount = 0;
    let correctlyMatchedToTrueCandidateCount = 0;

    for (const entityId of ambiguousEntityIds) {
      const settlementId = entityIdToSettlementId.get(entityId);
      if (settlementId === undefined) continue;

      const resolution = currentResolutionBySettlementId.get(settlementId);
      const matchCandidateIds = matchCandidateIdsBySettlementId.get(settlementId) ?? [];
      const inReviewQueue = matchCandidateIds.some((id) => matchCandidateIdsInReviewQueue.has(id));

      if (resolution || inReviewQueue) ok++;

      if (useRealAi && resolution && resolution.final_status === 'matched') {
        autoMatchedCount++;
        if (entityIdToIsTrueCandidate.get(entityId) === true) correctlyMatchedToTrueCandidateCount++;
      }
    }

    results.push(
      printRow('AMBIGUOUS_DUPLICATE settlements ended up in resolutions or review_queue (never lost)', ambiguousEntityIds.length, ok),
    );

    if (useRealAi) {
      console.log(
        `\n(informational, not PASS/FAIL - AI output isn't deterministic) Of ${autoMatchedCount} AMBIGUOUS_DUPLICATE ` +
          `settlement(s) auto-matched by the AI, ${correctlyMatchedToTrueCandidateCount} were matched to the settlement ` +
          `ground-truth.json marks as genuine (isTrueCandidate=true).`,
      );
    }
  }

  const allPass = results.every(Boolean);
  console.log(`\n${allPass ? '✅ All ground-truth checks passed.' : '❌ One or more ground-truth checks failed.'}`);

  await pool.end();

  if (!allPass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('❌ verify-decision-gate failed:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
