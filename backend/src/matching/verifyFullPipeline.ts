// Standalone end-to-end verification script.
//
//   npm run verify-pipeline
//
// Runs the full Stage 0-7 pipeline against the real seeded database, prints
// a route-distribution summary, and cross-checks the results against
// backend/src/db/ground-truth.json. The single most important check here is
// that no CORRUPTED_TRUNCATED/CORRUPTED_SUBSTITUTED settlement ever gets
// matched to the WRONG order - that failure mode must be zero.

import { loadSettlementsAndOrders } from './dbLoader';
import { loadGroundTruth } from './groundTruth';
import { runFullPipeline } from './runFullPipeline';
import { RoutedCase } from './thresholdGate';

function printRow(label: string, expected: number, found: number): boolean {
  const pass = expected === found;
  const status = pass ? '✅ MATCH' : '❌ FAIL';
  console.log(`${label.padEnd(75)} expected: ${String(expected).padEnd(5)} found: ${String(found).padEnd(5)} ${status}`);
  return pass;
}

async function main(): Promise<void> {
  console.log('Loading settlements, ledger orders, and ground truth...');
  const { settlements, orders } = await loadSettlementsAndOrders();
  const groundTruth = loadGroundTruth();
  console.log(
    `Loaded ${settlements.length} settlements, ${orders.length} ledger orders, ` +
      `${groundTruth.length} ground-truth entries.\n`,
  );

  console.log('Running the full pipeline (Stages 0-7)...\n');
  const routedCases = runFullPipeline(settlements, orders, groundTruth);

  // ---------------------------------------------------------------------
  // Route distribution
  // ---------------------------------------------------------------------
  console.log('=== Route distribution ===');
  const byRoute = new Map<string, RoutedCase[]>();
  for (const routedCase of routedCases) {
    const bucket = byRoute.get(routedCase.route);
    if (bucket) bucket.push(routedCase);
    else byRoute.set(routedCase.route, [routedCase]);
  }

  for (const route of ['auto_resolve', 'human_review', 'ai_investigation'] as const) {
    const cases = byRoute.get(route) ?? [];
    const totalSettlements = cases.reduce((sum, c) => sum + c.settlements.length, 0);
    console.log(`\n${route}: ${cases.length} case(s), ${totalSettlements} settlement(s)`);

    const byCaseType = new Map<string, number>();
    for (const c of cases) byCaseType.set(c.caseType, (byCaseType.get(c.caseType) ?? 0) + 1);
    for (const [caseType, count] of byCaseType) {
      console.log(`  - ${caseType}: ${count}`);
    }
  }

  // ---------------------------------------------------------------------
  // Ground-truth cross-checks
  // ---------------------------------------------------------------------
  console.log('\n=== Ground truth cross-check ===');

  const entityIdToCategory = new Map<string, string>();
  const entityIdToTrueOrderId = new Map<string, string>();
  for (const entry of groundTruth) {
    if (entry.entity_id !== null) {
      entityIdToCategory.set(entry.entity_id, entry.category);
      entityIdToTrueOrderId.set(entry.entity_id, entry.order_id);
    }
  }

  function casesContainingEntity(entityId: string): RoutedCase[] {
    return routedCases.filter((c) => c.settlements.some((s) => s.entityId === entityId));
  }

  const results: boolean[] = [];

  // Check 1: CLEAN_EXACT + ON_HOLD settlements -> auto_resolve.
  {
    let total = 0;
    let ok = 0;
    for (const [entityId, category] of entityIdToCategory) {
      if (category !== 'CLEAN_EXACT' && category !== 'ON_HOLD') continue;
      total++;
      const cases = casesContainingEntity(entityId);
      if (cases.length > 0 && cases.every((c) => c.route === 'auto_resolve')) ok++;
    }
    results.push(printRow('CLEAN_EXACT + ON_HOLD settlements routed to auto_resolve', total, ok));
  }

  // Check 2: CORRUPTED_TRUNCATED/SUBSTITUTED -> correctly matched
  // (auto_resolve or human_review, never ai_investigation), and - the single
  // most important check in this whole prompt - NEVER matched to the wrong
  // order.
  {
    let total = 0;
    let correctlyMatched = 0;
    let wrongOrderMatches = 0;

    for (const [entityId, category] of entityIdToCategory) {
      if (category !== 'CORRUPTED_TRUNCATED' && category !== 'CORRUPTED_SUBSTITUTED') continue;
      total++;

      const trueOrderId = entityIdToTrueOrderId.get(entityId)!;
      const cases = casesContainingEntity(entityId);

      const wrongOrderCase = cases.find((c) => c.order !== null && c.order.orderId !== trueOrderId);
      if (wrongOrderCase) {
        wrongOrderMatches++;
        console.log(
          `  ❌ WRONG-ORDER MATCH: settlement ${entityId} (${category}, true order ${trueOrderId}) was matched ` +
            `to ${wrongOrderCase.order!.orderId} (route: ${wrongOrderCase.route})`,
        );
        continue;
      }

      const matchedRight = cases.some(
        (c) => c.order !== null && c.order.orderId === trueOrderId && (c.route === 'auto_resolve' || c.route === 'human_review'),
      );
      if (matchedRight) correctlyMatched++;
    }

    results.push(
      printRow('CORRUPTED_TRUNCATED/SUBSTITUTED correctly matched (auto_resolve or human_review)', total, correctlyMatched),
    );
    results.push(printRow('CORRUPTED_TRUNCATED/SUBSTITUTED matched to the WRONG order (must be zero)', 0, wrongOrderMatches));
  }

  // Check 3: AMBIGUOUS_DUPLICATE settlements -> ai_investigation.
  {
    let total = 0;
    let ok = 0;
    for (const [entityId, category] of entityIdToCategory) {
      if (category !== 'AMBIGUOUS_DUPLICATE') continue;
      total++;
      const cases = casesContainingEntity(entityId);
      if (cases.length > 0 && cases.every((c) => c.route === 'ai_investigation')) ok++;
    }
    results.push(printRow('AMBIGUOUS_DUPLICATE settlements routed to ai_investigation', total, ok));
  }

  // Check 4: every SPLIT_PAYMENT order resolves via caseType='split_payment', route='auto_resolve'.
  {
    const splitOrderIds = new Set(groundTruth.filter((e) => e.category === 'SPLIT_PAYMENT').map((e) => e.order_id));
    let ok = 0;
    for (const orderId of splitOrderIds) {
      const matchingCase = routedCases.find((c) => c.caseType === 'split_payment' && c.order?.orderId === orderId);
      if (matchingCase && matchingCase.route === 'auto_resolve') ok++;
    }
    results.push(printRow('SPLIT_PAYMENT orders resolved via split_payment / auto_resolve', splitOrderIds.size, ok));
  }

  const allPass = results.every(Boolean);
  console.log(`\n${allPass ? '✅ All ground-truth checks passed.' : '❌ One or more ground-truth checks failed.'}`);

  if (!allPass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('❌ verifyFullPipeline failed:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
