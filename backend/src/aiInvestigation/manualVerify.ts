// Standalone verification script.
//
//   npm run verify-ai
//
// Loads every RoutedCase with route='ai_investigation' from a fresh run of
// the Stage 0-7 pipeline against the live DB, builds an evidence bundle for
// each, and calls the REAL Gemini API (not mocked) for each one. Prints a
// human-readable report per case, then a summary.
//
// This script does NOT produce a PASS/FAIL table like the deterministic
// pipeline's verification scripts (manualVerify.ts, verifyFullPipeline.ts) -
// LLM output is not deterministic enough to grade that way. The results
// printed here are for MANUAL HUMAN INSPECTION of the AI's reasoning
// quality, not automated correctness grading: there is no machine-checkable
// ground truth for what the "right" judgment call is on a genuinely
// ambiguous case.

import { loadSettlementsAndOrders } from '../matching/dbLoader';
import { loadGroundTruth } from '../matching/groundTruth';
import { runFullPipeline } from '../matching/runFullPipeline';
import { RoutedCase } from '../matching/thresholdGate';
import { buildEvidenceBundle } from './evidenceBundle';
import { investigate, AIInvestigationResult } from './investigate';

// The Gemini free tier enforces 5 requests/minute for this model (confirmed
// live: a back-to-back run of 9 calls hit 429 Too Many Requests on calls
// 5-9). Pacing calls at least 60s/5 = 12s apart keeps a full run comfortably
// under that limit; 13s is used for a small safety margin.
const MIN_MS_BETWEEN_CALLS = 13_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses `--limit=N` directly from process.argv rather than trusting npm's
 * `--` passthrough alone: `npm run verify-ai -- --limit=2` does forward
 * `--limit=2` into this script's argv, but reading argv ourselves means it
 * works the same whether invoked via `npm run ...  -- --limit=2`,
 * `npx ts-node src/aiInvestigation/manualVerify.ts --limit=2`, or any other
 * wrapper - nothing here depends on npm-specific behavior.
 */
function parseLimitArg(argv: string[]): number | null {
  for (const arg of argv) {
    const match = /^--limit=(\d+)$/.exec(arg);
    if (match) {
      const value = Number(match[1]);
      return value > 0 ? value : null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const limit = parseLimitArg(process.argv.slice(2));

  console.log('Loading settlements, ledger orders, and ground truth...');
  const { settlements, orders } = await loadSettlementsAndOrders();
  const groundTruth = loadGroundTruth();

  console.log('Running the full pipeline (Stages 0-7)...\n');
  const { routedCases } = runFullPipeline(settlements, orders, groundTruth);

  const allAiCases = routedCases.filter((c) => c.route === 'ai_investigation');
  const aiCases = limit !== null ? allAiCases.slice(0, limit) : allAiCases;

  console.log(`Found ${allAiCases.length} case(s) routed to ai_investigation.`);
  if (limit !== null) {
    console.log(`--limit=${limit} passed: processing only the first ${aiCases.length} of them.`);
  }
  console.log(
    `Each one below makes ONE real call to the Gemini API, paced ${MIN_MS_BETWEEN_CALLS / 1000}s apart to stay ` +
      'under the free tier\'s 5 requests/minute limit for this model - a full run takes a few minutes.\n',
  );

  if (aiCases.length === 0) {
    console.log('Nothing to investigate in this run.');
    return;
  }

  const results: { routedCase: RoutedCase; result: AIInvestigationResult }[] = [];

  for (let i = 0; i < aiCases.length; i++) {
    if (i > 0) {
      console.log(`(pacing ${MIN_MS_BETWEEN_CALLS / 1000}s before the next call to stay under the free-tier rate limit...)\n`);
      await sleep(MIN_MS_BETWEEN_CALLS);
    }

    const routedCase = aiCases[i];
    console.log('='.repeat(80));
    console.log(`Case ${i + 1}/${aiCases.length}  |  caseType: ${routedCase.caseType}  |  reasonCode: ${routedCase.reasonCode}`);
    console.log('='.repeat(80));

    const { bundle } = buildEvidenceBundle(routedCase);
    console.log('Evidence bundle sent to Gemini (tokens only - no real IDs):');
    console.log(JSON.stringify(bundle, null, 2));

    const result = await investigate(bundle); // REAL Gemini API call - not mocked
    results.push({ routedCase, result });

    console.log(`\nstatus: ${result.status}   latencyMs: ${result.latencyMs}`);
    if (result.classification) {
      console.log('classification:');
      console.log(JSON.stringify(result.classification, null, 2));
    }
    if (result.errorMessage) {
      console.log(`errorMessage: ${result.errorMessage}`);
    }
    if (result.status === 'invalid_output' && result.rawResponse) {
      console.log(`rawResponse (validation failed, preserved anyway): ${result.rawResponse}`);
    }
    console.log('');
  }

  // ---------------------------------------------------------------------
  // Summary (NOT a PASS/FAIL table - see header comment)
  // ---------------------------------------------------------------------
  console.log('='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total cases investigated: ${results.length}\n`);

  const byStatus = new Map<string, number>();
  for (const { result } of results) {
    byStatus.set(result.status, (byStatus.get(result.status) ?? 0) + 1);
  }
  console.log('By status:');
  for (const status of ['success', 'timeout', 'error', 'invalid_output']) {
    console.log(`  ${status}: ${byStatus.get(status) ?? 0}`);
  }

  const successResults = results.filter(({ result }) => result.status === 'success');
  const byClassification = new Map<string, number>();
  for (const { result } of successResults) {
    const classification = result.classification!.classification;
    byClassification.set(classification, (byClassification.get(classification) ?? 0) + 1);
  }
  console.log(`\nAmong ${successResults.length} successful classification(s):`);
  for (const classification of ['MATCH_FOUND', 'MULTIPLE_MATCH_FOUND', 'NO_VIABLE_MATCH', 'INSUFFICIENT_EVIDENCE']) {
    console.log(`  ${classification}: ${byClassification.get(classification) ?? 0}`);
  }

  console.log(
    '\nThese results are for MANUAL HUMAN INSPECTION of AI reasoning quality only - there is no\n' +
      'machine-checkable ground truth for what the "right" judgment call is on genuinely ambiguous\n' +
      'cases, so this script intentionally does not print a PASS/FAIL table.',
  );
}

main().catch((err) => {
  console.error('❌ verify-ai failed:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
