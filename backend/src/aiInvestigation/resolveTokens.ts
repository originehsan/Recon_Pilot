// Step 5: translate the LLM's token-based answer back into real settlement
// ids. This is the ONLY place the token -> real-id map is ever read - kept
// out of investigate.ts and llmClient.ts on purpose, so nothing that
// constructs an LLM prompt ever has access to it.
//
// Tokens only ever refer to settlements (evidenceBundle.ts assigns one token
// per candidate settlement, never per order) - there is no separate
// order-token concept, so this resolves to settlement ids only.

import { AIInvestigationResult } from './investigate';

export function resolveTokens(tokenToSettlementId: Map<string, number>, result: AIInvestigationResult): number[] {
  if (result.status !== 'success' || result.classification === null) {
    return [];
  }

  return result.classification.selectedTokens.map((token) => {
    const settlementId = tokenToSettlementId.get(token);
    if (settlementId === undefined) {
      // Defensive: outputSchema.ts's semantic check only confirms a token is
      // SHAPED like "CANDIDATE_[A-Z]+" - it doesn't (can't, without the
      // bundle) confirm the token actually came from THIS bundle. A model
      // could still invent "CANDIDATE_Z" when the bundle only had A and B.
      // Never silently drop or guess at a fallback here.
      throw new Error(
        `resolveTokens: token "${token}" from the model's response does not exist in this bundle's token map.`,
      );
    }
    return settlementId;
  });
}
