// Step 4: orchestration + circuit breaker.
//
// This function has NO database dependency: its signature takes only an
// EvidenceBundle (plus an optional, defaulted LLM client for testability)
// and returns a result - nothing else. It imports no repository, and never
// will by construction: there is nothing in this file that could reach a
// database even by accident. This is enforced by the function signature
// itself, not by convention.

import { EvidenceBundle } from './evidenceBundle';
import { callGemini, LLMTimeoutError } from './llmClient';
import { AIInvestigationOutput, validateAndParseOutput } from './outputSchema';

export interface AIInvestigationResult {
  status: 'success' | 'timeout' | 'error' | 'invalid_output';
  classification: AIInvestigationOutput | null;
  rawResponse: string | null;
  latencyMs: number;
  errorMessage: string | null;
}

/**
 * Anything that can turn an EvidenceBundle into raw LLM text. In production
 * this defaults to the real Gemini client (llmClient.ts); tests inject a
 * fake one instead of hitting the network.
 */
export type GeminiClient = (bundle: EvidenceBundle) => Promise<{ text: string }>;

// Deliberately NOT implemented in this prompt: evidence-staleness/version
// checking, and the 'stale_evidence' status. That requires the
// evidence-versioning mechanism that belongs to the decision-gate stage
// (a future prompt), which does not exist yet.

export async function investigate(bundle: EvidenceBundle, client: GeminiClient = callGemini): Promise<AIInvestigationResult> {
  const startedAt = Date.now();

  let rawText: string;
  try {
    const result = await client(bundle);
    rawText = result.text;
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    if (err instanceof LLMTimeoutError) {
      return { status: 'timeout', classification: null, rawResponse: null, latencyMs, errorMessage: err.message };
    }
    return {
      status: 'error',
      classification: null,
      rawResponse: null,
      latencyMs,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  const latencyMs = Date.now() - startedAt;
  const validation = validateAndParseOutput(rawText);

  if (!validation.success) {
    return {
      status: 'invalid_output',
      classification: null,
      rawResponse: rawText, // never discard the raw output, even on failure - needed for audit later
      latencyMs,
      errorMessage: validation.error,
    };
  }

  return {
    status: 'success',
    classification: validation.data,
    rawResponse: rawText,
    latencyMs,
    errorMessage: null,
  };
}
