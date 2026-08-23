// Step 1: build the evidence bundle sent to the LLM.
//
// This is an ALLOW-LIST implementation, not a block-list: only the fields
// named in EvidenceBundle are ever included. Explicitly never included:
// entity_id, settlement_id, settlement_utr, order_id, payment_id,
// dispute_id (only the derived boolean hasDispute), or any raw_payload
// content. Real settlement/order ids never leave this module - everything
// downstream of here (llmClient.ts, investigate.ts) only ever sees
// correlation tokens ("CANDIDATE_A", ...).

import { RoutedCase } from '../matching/thresholdGate';

export type AIInvestigationCaseType = 'ambiguous_duplicate' | 'split_payment_ambiguous' | 'residual_no_match';

export interface EvidenceBundle {
  caseType: AIInvestigationCaseType;
  orderContext: { expectedAmount: number; currency: string } | null;
  candidates: {
    token: string; // "CANDIDATE_A", "CANDIDATE_B", ... - never a real ID
    amount: number;
    fee: number;
    tax: number;
    creditType: string | null;
    hasDispute: boolean;
    narration: string | null;
  }[];
}

export interface BuildEvidenceBundleResult {
  bundle: EvidenceBundle;
  /**
   * token -> real settlement.id. Returned as a value SEPARATE from `bundle`
   * (never embedded inside it), so nothing that goes on to serialize
   * `bundle` into an LLM prompt (llmClient.ts) ever has access to real ids.
   * Only resolveTokens.ts (Step 5) should ever read this map, to translate
   * the LLM's token-based answer back into a real settlement after the
   * fact.
   */
  tokenToSettlementId: Map<string, number>;
}

// The only currency this project's seed data ever generates (see seed.ts).
const CURRENCY = 'INR';

const SUPPORTED_CASE_TYPES: readonly AIInvestigationCaseType[] = [
  'ambiguous_duplicate',
  'split_payment_ambiguous',
  'residual_no_match',
];

/** CANDIDATE_A, CANDIDATE_B, ..., CANDIDATE_Z, CANDIDATE_AA, CANDIDATE_AB, ... */
function tokenForIndex(index: number): string {
  let n = index;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `CANDIDATE_${letters}`;
}

export function buildEvidenceBundle(routedCase: RoutedCase): BuildEvidenceBundleResult {
  if (routedCase.route !== 'ai_investigation') {
    throw new Error(`buildEvidenceBundle: expected an ai_investigation-routed case, got route "${routedCase.route}".`);
  }
  if (!SUPPORTED_CASE_TYPES.includes(routedCase.caseType as AIInvestigationCaseType)) {
    throw new Error(`buildEvidenceBundle: unsupported caseType "${routedCase.caseType}" for AI investigation.`);
  }
  const caseType = routedCase.caseType as AIInvestigationCaseType;

  // Stable, deterministic token order: settlement.id ascending. Tokens carry
  // no meaning outside this one bundle - a fresh call gets fresh tokens.
  const orderedSettlements = [...routedCase.settlements].sort((a, b) => a.id - b.id);

  const tokenToSettlementId = new Map<string, number>();
  const candidates = orderedSettlements.map((settlement, index) => {
    const token = tokenForIndex(index);
    tokenToSettlementId.set(token, settlement.id);
    return {
      token,
      amount: settlement.amount,
      fee: settlement.fee,
      tax: settlement.tax,
      creditType: settlement.creditType,
      hasDispute: settlement.hasDispute,
      narration: settlement.narration,
    };
  });

  const orderContext = routedCase.order
    ? { expectedAmount: routedCase.order.expectedAmount, currency: CURRENCY }
    : null;

  return {
    bundle: { caseType, orderContext, candidates },
    tokenToSettlementId,
  };
}
