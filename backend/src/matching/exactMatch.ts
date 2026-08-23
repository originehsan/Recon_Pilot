// Stage 1: exact hash-join match between settlements and ledger orders.
//
// All monetary fields (amount, fee, tax, expectedAmount) are assumed to
// already be integers in the smallest indivisible currency unit (paise) by
// the time they reach this function - see the DB-loading layer
// (manualVerify.ts's decimalStringToInt), which converts MySQL DECIMAL
// values to exact integers before constructing Settlement/LedgerOrder
// objects. That is what makes the `===` amount check below exact: plain JS
// number equality is only safe for whole integers, never for fractional
// decimals (0.1 + 0.2 !== 0.3).

import { LedgerOrder, Settlement } from './types';

export interface ExactMatchResult {
  exactMatches: { settlement: Settlement; order: LedgerOrder }[];
  ambiguousExactDuplicates: { settlement: Settlement; order: LedgerOrder }[];
  amountMismatches: { settlement: Settlement; order: LedgerOrder }[];
  noOrderIdMatch: Settlement[];
  unmatchedOrders: LedgerOrder[];
}

/**
 * O(N + M): one pass over `orders` to build an order_id -> LedgerOrder map,
 * one pass over `settlements` to probe it. No nested loop over the full
 * settlement x order cross product.
 */
export function runExactMatch(settlements: Settlement[], orders: LedgerOrder[]): ExactMatchResult {
  const orderById = new Map<string, LedgerOrder>();
  for (const order of orders) {
    orderById.set(order.orderId, order);
  }

  const amountMismatches: { settlement: Settlement; order: LedgerOrder }[] = [];
  const noOrderIdMatch: Settlement[] = [];

  // order_id -> every settlement whose amount reconciled exactly against
  // that order. Grouped so we can tell a single clean match apart from an
  // ambiguous duplicate (>1 settlement reconciling against the same order).
  const candidateExactByOrderId = new Map<string, { settlement: Settlement; order: LedgerOrder }[]>();

  for (const settlement of settlements) {
    const order = orderById.get(settlement.orderId);

    if (!order) {
      noOrderIdMatch.push(settlement);
      continue;
    }

    const reconciledAmount = order.expectedAmount - settlement.fee - settlement.tax;

    if (settlement.amount === reconciledAmount) {
      const bucket = candidateExactByOrderId.get(order.orderId);
      if (bucket) {
        bucket.push({ settlement, order });
      } else {
        candidateExactByOrderId.set(order.orderId, [{ settlement, order }]);
      }
    } else {
      amountMismatches.push({ settlement, order });
    }
  }

  const exactMatches: { settlement: Settlement; order: LedgerOrder }[] = [];
  const ambiguousExactDuplicates: { settlement: Settlement; order: LedgerOrder }[] = [];

  for (const pairs of candidateExactByOrderId.values()) {
    if (pairs.length === 1) {
      exactMatches.push(pairs[0]);
    } else {
      // Two or more settlements share the same order_id AND both reconcile
      // exactly against that order's expected amount. This is intentional,
      // not a bug: picking one arbitrarily would be a silent guess with real
      // money on the line, which violates the system's core "never guess on
      // money" principle. Every one of them goes to ambiguousExactDuplicates
      // for a human/AI to disambiguate later - none of them go to
      // exactMatches.
      ambiguousExactDuplicates.push(...pairs);
    }
  }

  const referencedOrderIds = new Set<string>();
  for (const { order } of exactMatches) referencedOrderIds.add(order.orderId);
  for (const { order } of ambiguousExactDuplicates) referencedOrderIds.add(order.orderId);
  for (const { order } of amountMismatches) referencedOrderIds.add(order.orderId);

  const unmatchedOrders = orders.filter((order) => !referencedOrderIds.has(order.orderId));

  return { exactMatches, ambiguousExactDuplicates, amountMismatches, noOrderIdMatch, unmatchedOrders };
}
