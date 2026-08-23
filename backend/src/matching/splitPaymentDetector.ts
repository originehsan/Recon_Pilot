// Stage 3: exact subset-sum split-payment detection.
//
// Operates only on Stage 1's `amountMismatches` bucket: these are
// settlements whose order_id matched an order exactly but whose individual
// amount did not reconcile - exactly where a split payment's legs land,
// since each leg only ever carries part of the order's total.

import { LedgerOrder, Settlement } from './types';

export interface SplitPaymentResult {
  orderId: string;
  order: LedgerOrder;
  status: 'UNIQUE_SOLUTION' | 'AMBIGUOUS' | 'NO_SOLUTION';
  matchedSettlements: Settlement[] | null;
  allValidSubsets: Settlement[][];
}

// Integer-paise tolerance for a subset's summed amount vs. the order's
// expected amount net of that subset's own fee/tax.
const TOLERANCE_PAISE = 5;

/** All subsets of `items` of exactly `size` elements (order-preserving, no repeats). */
function combinationsOfSize<T>(items: T[], size: number): T[][] {
  const results: T[][] = [];
  const combo: T[] = [];

  function recurse(start: number): void {
    if (combo.length === size) {
      results.push(combo.slice());
      return;
    }
    for (let i = start; i < items.length; i++) {
      combo.push(items[i]);
      recurse(i + 1);
      combo.pop();
    }
  }

  recurse(0);
  return results;
}

/**
 * Scope is intentionally limited to 2- and 3-way splits (the seed data never
 * generates more than 3 legs per split order, and unbounded subset search is
 * exponential in the number of candidate settlements for that order).
 */
export function detectSplitPayments(
  amountMismatches: { settlement: Settlement; order: LedgerOrder }[],
): SplitPaymentResult[] {
  const byOrderId = new Map<string, { order: LedgerOrder; settlements: Settlement[] }>();

  for (const { settlement, order } of amountMismatches) {
    const bucket = byOrderId.get(order.orderId);
    if (bucket) {
      bucket.settlements.push(settlement);
    } else {
      byOrderId.set(order.orderId, { order, settlements: [settlement] });
    }
  }

  const results: SplitPaymentResult[] = [];

  for (const [orderId, { order, settlements }] of byOrderId) {
    // A single mismatched settlement alone cannot be a split payment - it's
    // just a mismatch with no partner to sum against. Skip it here; the
    // caller is responsible for handling lone amount-mismatches separately.
    if (settlements.length < 2) {
      continue;
    }

    const validSubsets: Settlement[][] = [];

    for (const size of [2, 3]) {
      if (settlements.length < size) continue;

      for (const subset of combinationsOfSize(settlements, size)) {
        const subsetAmount = subset.reduce((sum, s) => sum + s.amount, 0);
        const subsetFeeAndTax = subset.reduce((sum, s) => sum + s.fee + s.tax, 0);
        const target = order.expectedAmount - subsetFeeAndTax;

        if (Math.abs(subsetAmount - target) <= TOLERANCE_PAISE) {
          validSubsets.push(subset);
        }
      }
    }

    if (validSubsets.length === 1) {
      results.push({
        orderId,
        order,
        status: 'UNIQUE_SOLUTION',
        matchedSettlements: validSubsets[0],
        allValidSubsets: validSubsets,
      });
    } else if (validSubsets.length === 0) {
      results.push({
        orderId,
        order,
        status: 'NO_SOLUTION',
        matchedSettlements: null,
        allValidSubsets: [],
      });
    } else {
      // Two or more subsets both reconcile (e.g. {A,B} and {C,D} both sum
      // correctly). Never guess which one is real - surface every candidate
      // subset instead of picking one.
      results.push({
        orderId,
        order,
        status: 'AMBIGUOUS',
        matchedSettlements: null,
        allValidSubsets: validSubsets,
      });
    }
  }

  return results;
}
