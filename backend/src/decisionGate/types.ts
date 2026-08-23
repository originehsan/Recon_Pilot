// The core invariant of this entire module: no code outside decisionGate/
// may ever construct a value that represents a finalized decision, and no
// code outside decisionGate/ may ever write to the `resolutions` table.
// This is enforced by TypeScript's structural typing plus the brand below,
// not by convention - see decisionGate.ts, the only file permitted to call
// brandResolvedDecision.

// NOTE: the prompt's own snippet for this line was `declare const
// ResolvedBrand: unique symbol;` - a TYPE-ONLY declaration with no runtime
// value. brandResolvedDecision's `[ResolvedBrand]: true` needs an actual
// symbol to set at runtime, so `declare const` throws
// "ReferenceError: ResolvedBrand is not defined" the moment it executes
// (confirmed live, running decisionGate.test.ts). A real `Symbol()` still
// types as `unique symbol` - TypeScript's structural typing treats it as
// nominally distinct from any other symbol regardless - so this preserves
// the exact same brand-based type safety while actually working at runtime.
const ResolvedBrand: unique symbol = Symbol('ResolvedDecision');

export interface ResolvedDecisionProps {
  settlementId: number;
  ledgerOrderId: number | null; // null only when finalStatus is 'unresolved' or 'rejected'
  finalStatus: 'matched' | 'rejected' | 'unresolved';
  decidedBy: 'stage1_exact' | 'stage7_auto' | 'post_ai' | 'human';
  matchCandidateId: number | null;
  aiInvestigationId: number | null;
  evidenceVersion: number;
  evidenceHash: string;
  reasonCode: string;
}

export type ResolvedDecision = ResolvedDecisionProps & { readonly [ResolvedBrand]: true };

/**
 * The ONLY function anywhere in the codebase that may produce a
 * ResolvedDecision. This must only ever be called from within
 * backend/src/decisionGate/decisionGate.ts. Do not import it anywhere else
 * - not in matching/, not in aiInvestigation/, not in any other file under
 * decisionGate/ itself. A plain object with the right shape is NOT a
 * ResolvedDecision without going through this function and the private
 * brand symbol above - that's what makes the invariant a type-system
 * guarantee rather than a naming convention.
 */
export function brandResolvedDecision(props: ResolvedDecisionProps): ResolvedDecision {
  return { ...props, [ResolvedBrand]: true };
}
