// Final routing: turns every deterministic match, split-payment result, and
// Hungarian assignment into a routing decision. This produces routing labels
// only - no final money decisions, no AI calls (Stage 8), no decision-gate
// finalization (Stage 9), no audit logging (Stage 10). All of those are out
// of scope here.

import { AssignmentResult } from './hungarianAssignment';
import { SplitPaymentResult } from './splitPaymentDetector';
import { Thresholds } from './calibrateThresholds';
import { LedgerOrder, Settlement } from './types';

export type Route = 'auto_resolve' | 'human_review' | 'ai_investigation';

export interface RoutedCase {
  caseType:
    | 'exact_match'
    | 'split_payment'
    | 'ambiguous_duplicate'
    | 'split_payment_ambiguous'
    | 'residual_match'
    | 'residual_no_match';
  settlements: Settlement[];
  order: LedgerOrder | null;
  fsScore: number | null;
  route: Route;
  reasonCode: string;
}

function dedupeSettlementsById(settlements: Settlement[]): Settlement[] {
  const byId = new Map<number, Settlement>();
  for (const settlement of settlements) {
    if (!byId.has(settlement.id)) {
      byId.set(settlement.id, settlement);
    }
  }
  return Array.from(byId.values());
}

export function routeAllCases(
  exactMatches: { settlement: Settlement; order: LedgerOrder }[],
  ambiguousExactDuplicates: { settlement: Settlement; order: LedgerOrder }[],
  splitPaymentResults: SplitPaymentResult[],
  hungarianResults: AssignmentResult[],
  thresholds: Thresholds,
): RoutedCase[] {
  const routedCases: RoutedCase[] = [];

  // Rule 1: exact matches are deterministic - no FS scoring needed.
  for (const { settlement, order } of exactMatches) {
    routedCases.push({
      caseType: 'exact_match',
      settlements: [settlement],
      order,
      fsScore: null,
      route: 'auto_resolve',
      reasonCode: 'exact_id_and_amount_match',
    });
  }

  // Rule 2: ambiguous exact duplicates, grouped by order - one RoutedCase
  // per order, containing every tied settlement, not one case per pair.
  const ambiguousByOrderId = new Map<string, { order: LedgerOrder; settlements: Settlement[] }>();
  for (const { settlement, order } of ambiguousExactDuplicates) {
    const bucket = ambiguousByOrderId.get(order.orderId);
    if (bucket) {
      bucket.settlements.push(settlement);
    } else {
      ambiguousByOrderId.set(order.orderId, { order, settlements: [settlement] });
    }
  }
  for (const { order, settlements } of ambiguousByOrderId.values()) {
    routedCases.push({
      caseType: 'ambiguous_duplicate',
      settlements,
      order,
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'multiple_settlements_same_order_same_amount_no_discriminating_signal',
    });
  }

  // Rules 3 & 4: split-payment results.
  for (const result of splitPaymentResults) {
    if (result.status === 'UNIQUE_SOLUTION') {
      routedCases.push({
        caseType: 'split_payment',
        settlements: result.matchedSettlements!,
        order: result.order,
        fsScore: null,
        route: 'auto_resolve',
        reasonCode: 'unique_subset_sum_match',
      });
    } else {
      // AMBIGUOUS: surface the union of every settlement that appears in any
      // valid subset - there's no discriminating signal for which subset is
      // real, so all of them are relevant to whoever reviews this.
      // NO_SOLUTION: allValidSubsets is empty by definition, and
      // SplitPaymentResult does not retain the original candidate list for
      // that order, so settlements is legitimately empty here, not
      // fabricated.
      const involvedSettlements = dedupeSettlementsById(result.allValidSubsets.flat());
      routedCases.push({
        caseType: 'split_payment_ambiguous',
        settlements: involvedSettlements,
        order: result.order,
        fsScore: null,
        route: 'ai_investigation',
        reasonCode: result.status === 'AMBIGUOUS' ? 'multiple_valid_subset_sums' : 'no_subset_sum_reconciles',
      });
    }
  }

  // Rules 5 & 6: Hungarian-assigned residual candidates. These share the
  // same source (Hungarian's per-settlement assignment) but split into two
  // distinct caseTypes based on whether a real order was found at all:
  // 'residual_match' (Rule 5 - order !== null, routed to auto_resolve or
  // human_review by score) vs 'residual_no_match' (Rule 6 - order === null,
  // Hungarian assigned this settlement to a dummy node, always
  // ai_investigation). Keeping them as separate caseTypes means a consumer
  // filtering on caseType alone can't conflate "found and scored" with "no
  // viable candidate" - route/reasonCode alone were not enough of a signal.
  for (const result of hungarianResults) {
    if (result.order !== null) {
      const fsScore = result.fsScore as number; // always non-null when order is non-null (see assignComponent)

      if (fsScore >= thresholds.upper) {
        routedCases.push({
          caseType: 'residual_match',
          settlements: [result.settlement],
          order: result.order,
          fsScore,
          route: 'auto_resolve',
          reasonCode: 'fs_score_above_calibrated_threshold',
        });
      } else if (fsScore >= thresholds.lower) {
        routedCases.push({
          caseType: 'residual_match',
          settlements: [result.settlement],
          order: result.order,
          fsScore,
          route: 'human_review',
          reasonCode: 'fs_score_in_review_band',
        });
      } else {
        // Components are only ever built from edges >= lowerThreshold (see
        // ambiguityComponents.ts), so a real (non-dummy) Hungarian assignment
        // scoring below `lower` should be unreachable. Throw rather than
        // silently misroute a case that shouldn't exist.
        throw new Error(
          `routeAllCases: Hungarian-assigned fsScore ${fsScore} for settlement id ${result.settlement.id} is ` +
            `below the lower threshold (${thresholds.lower}). This should be unreachable - components are only ` +
            'built from edges >= lowerThreshold.',
        );
      }
    } else {
      routedCases.push({
        caseType: 'residual_no_match',
        settlements: [result.settlement],
        order: null,
        fsScore: null,
        route: 'ai_investigation',
        reasonCode: 'no_viable_candidate_in_component',
      });
    }
  }

  return routedCases;
}
