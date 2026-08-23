// Shared types for the deterministic matching pipeline (Stages 0-4).
// Every file under backend/src/matching/ uses these field names exactly -
// no alternate spellings, no ad-hoc shapes.

export interface Settlement {
  id: number;
  entityId: string;
  orderId: string;
  amount: number;
  fee: number;
  tax: number;
  settlementUtr: string | null;
}

export interface LedgerOrder {
  id: number;
  orderId: string;
  expectedAmount: number;
  expectedDate: string | null;
}

export interface CandidatePair {
  settlement: Settlement;
  order: LedgerOrder;
  amountDelta: number;
  dateDeltaDays: number | null;
  stringSimilarity: number | null;
}
