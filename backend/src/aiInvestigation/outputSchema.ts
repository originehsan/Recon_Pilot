// Step 3: schema and validation for whatever text the LLM actually returns.
// Never trust it just because it parsed as JSON - it must also match the
// exact shape we asked for, and every selected token must at least look
// like one we could have issued.

import { z } from 'zod';

export const AIInvestigationOutputSchema = z.object({
  classification: z.enum(['MATCH_FOUND', 'MULTIPLE_MATCH_FOUND', 'NO_VIABLE_MATCH', 'INSUFFICIENT_EVIDENCE']),
  selectedTokens: z.array(z.string()).max(10), // empty array unless classification is MATCH_FOUND or MULTIPLE_MATCH_FOUND
  confidence: z.number().min(0).max(1),
  explanation: z.string().max(1000),
});

export type AIInvestigationOutput = z.infer<typeof AIInvestigationOutputSchema>;

// Tokens issued by evidenceBundle.ts always look like this. A token that
// doesn't match isn't just malformed - it's evidence the model invented
// something it wasn't given (or hallucinated a different naming scheme).
const TOKEN_PATTERN = /^CANDIDATE_[A-Z]+$/;

export function validateAndParseOutput(
  rawText: string,
): { success: true; data: AIInvestigationOutput } | { success: false; error: string } {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (err) {
    return {
      success: false,
      error: `Response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const schemaResult = AIInvestigationOutputSchema.safeParse(parsedJson);
  if (!schemaResult.success) {
    return { success: false, error: `Schema validation failed: ${schemaResult.error.message}` };
  }

  // Semantic check beyond pure schema shape: every selectedToken must match
  // the correlation-token pattern evidenceBundle.ts actually issues. This
  // catches a model that invents a token (e.g. "candidate-3" or
  // "CANDIDATE_1") that was never in the evidence bundle it was given -
  // z.string() alone would happily accept any such string.
  const invalidTokens = schemaResult.data.selectedTokens.filter((token) => !TOKEN_PATTERN.test(token));
  if (invalidTokens.length > 0) {
    return {
      success: false,
      error: `selectedTokens contains token(s) not matching the CANDIDATE_[A-Z]+ pattern: ${invalidTokens.join(', ')}`,
    };
  }

  return { success: true, data: schemaResult.data };
}
