// Standalone verification script.
//
//   npm run verify-matching
//
// Loads the real seeded settlements/orders from the database, runs Stage 1
// (exact match) and Stage 3 (split-payment detection) over them, and
// cross-checks the resulting counts against backend/src/db/ground-truth.json
// (the true category of every seeded record) to prove the pipeline actually
// recovers what the seed data says it should.

import { runExactMatch } from './exactMatch';
import { detectSplitPayments } from './splitPaymentDetector';
import { loadSettlementsAndOrders } from './dbLoader';
import { GroundTruthEntry, loadGroundTruth } from './groundTruth';

function countEntries(groundTruth: GroundTruthEntry[], category: string): number {
  return groundTruth.filter((e) => e.category === category).length;
}

function countDistinctOrders(groundTruth: GroundTruthEntry[], category: string): number {
  return new Set(groundTruth.filter((e) => e.category === category).map((e) => e.order_id)).size;
}

function printComparisonRow(label: string, expected: number, found: number): boolean {
  const pass = expected === found;
  const status = pass ? '✅ MATCH' : '❌ FAIL';
  console.log(`${label.padEnd(70)} expected: ${String(expected).padEnd(5)} found: ${String(found).padEnd(5)} ${status}`);
  return pass;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Loading settlements and ledger orders from the database...');
  const { settlements, orders } = await loadSettlementsAndOrders();
  console.log(`Loaded ${settlements.length} settlements and ${orders.length} ledger orders.\n`);

  console.log('=== Stage 1: Exact Match ===');
  const stage1 = runExactMatch(settlements, orders);
  console.log(`exactMatches:             ${stage1.exactMatches.length}`);
  console.log(`ambiguousExactDuplicates: ${stage1.ambiguousExactDuplicates.length}`);
  console.log(`amountMismatches:         ${stage1.amountMismatches.length}`);
  console.log(`noOrderIdMatch:           ${stage1.noOrderIdMatch.length}`);
  console.log(`unmatchedOrders:          ${stage1.unmatchedOrders.length}`);

  console.log('\n=== Stage 3: Split-Payment Detection (over Stage 1 amountMismatches) ===');
  const splitResults = detectSplitPayments(stage1.amountMismatches);
  const uniqueCount = splitResults.filter((r) => r.status === 'UNIQUE_SOLUTION').length;
  const ambiguousCount = splitResults.filter((r) => r.status === 'AMBIGUOUS').length;
  const noSolutionCount = splitResults.filter((r) => r.status === 'NO_SOLUTION').length;
  console.log(`UNIQUE_SOLUTION: ${uniqueCount}`);
  console.log(`AMBIGUOUS:       ${ambiguousCount}`);
  console.log(`NO_SOLUTION:     ${noSolutionCount}`);

  const groundTruth = loadGroundTruth();

  console.log('\n=== Ground truth cross-check ===');
  console.log(
    [
      'Notes:',
      '- ON_HOLD settlements reconcile exactly the same way CLEAN_EXACT ones do, and the',
      '  Settlement interface Stage 1 operates on has no on_hold field at all - the two are',
      "  genuinely indistinguishable at this stage (separating them is the decision gate's",
      '  job, out of scope here), so they are combined in the row below.',
      '- CORRUPTED_TRUNCATED/CORRUPTED_SUBSTITUTED settlements have order_ids that Stage 1\'s',
      "  hash lookup cannot recognize at all, so they land in noOrderIdMatch and their true",
      '  orders land in unmatchedOrders alongside genuinely UNMATCHED ones. Recovering them',
      '  is Stage 2-4\'s job (fuzzy matching), which this script does not invoke.',
      '',
    ].join('\n'),
  );

  const results: boolean[] = [];

  results.push(
    printComparisonRow(
      'CLEAN_EXACT + ON_HOLD ground truth  vs  exactMatches',
      countEntries(groundTruth, 'CLEAN_EXACT') + countEntries(groundTruth, 'ON_HOLD'),
      stage1.exactMatches.length,
    ),
  );

  results.push(
    printComparisonRow(
      'AMBIGUOUS_DUPLICATE ground truth  vs  ambiguousExactDuplicates',
      countEntries(groundTruth, 'AMBIGUOUS_DUPLICATE'),
      stage1.ambiguousExactDuplicates.length,
    ),
  );

  results.push(
    printComparisonRow(
      'CORRUPTED_TRUNCATED + CORRUPTED_SUBSTITUTED ground truth  vs  noOrderIdMatch',
      countEntries(groundTruth, 'CORRUPTED_TRUNCATED') + countEntries(groundTruth, 'CORRUPTED_SUBSTITUTED'),
      stage1.noOrderIdMatch.length,
    ),
  );

  results.push(
    printComparisonRow(
      'SPLIT_PAYMENT settlement legs ground truth  vs  amountMismatches',
      countEntries(groundTruth, 'SPLIT_PAYMENT'),
      stage1.amountMismatches.length,
    ),
  );

  results.push(
    printComparisonRow(
      'SPLIT_PAYMENT orders ground truth  vs  split-payment UNIQUE_SOLUTION count',
      countDistinctOrders(groundTruth, 'SPLIT_PAYMENT'),
      uniqueCount,
    ),
  );

  results.push(
    printComparisonRow(
      'UNMATCHED + CORRUPTED (Stage-1-unrecoverable) ground truth  vs  unmatchedOrders',
      countEntries(groundTruth, 'UNMATCHED') +
        countEntries(groundTruth, 'CORRUPTED_TRUNCATED') +
        countEntries(groundTruth, 'CORRUPTED_SUBSTITUTED'),
      stage1.unmatchedOrders.length,
    ),
  );

  const allPass = results.every(Boolean);
  console.log(`\n${allPass ? '✅ All ground-truth checks passed.' : '❌ One or more ground-truth checks failed.'}`);

  if (!allPass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('❌ manualVerify failed:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
