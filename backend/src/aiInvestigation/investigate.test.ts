import { describe, expect, it, vi } from 'vitest';
import { investigate, GeminiClient } from './investigate';
import { EvidenceBundle } from './evidenceBundle';
import { LLMTimeoutError } from './llmClient';

const bundle: EvidenceBundle = {
  caseType: 'ambiguous_duplicate',
  orderContext: { expectedAmount: 1000, currency: 'INR' },
  candidates: [
    {
      token: 'CANDIDATE_A',
      amount: 1000,
      fee: 20,
      tax: 4,
      creditType: 'default',
      hasDispute: false,
      narration: 'Settlement matches the sole confirmed payment attempt for this order.',
    },
    {
      token: 'CANDIDATE_B',
      amount: 1000,
      fee: 20,
      tax: 4,
      creditType: 'default',
      hasDispute: false,
      narration: 'Retry after gateway timeout, original attempt unconfirmed.',
    },
  ],
};

describe('investigate', () => {
  it('returns status success with parsed classification on a valid response, never calling the real network', async () => {
    const validJson = JSON.stringify({
      classification: 'MATCH_FOUND',
      selectedTokens: ['CANDIDATE_A'],
      confidence: 0.9,
      explanation: 'Narration confirms the original payment.',
    });
    const client: GeminiClient = vi.fn().mockResolvedValue({ text: validJson });

    const result = await investigate(bundle, client);

    expect(client).toHaveBeenCalledTimes(1);
    expect(client).toHaveBeenCalledWith(bundle);
    expect(result.status).toBe('success');
    expect(result.classification).toEqual({
      classification: 'MATCH_FOUND',
      selectedTokens: ['CANDIDATE_A'],
      confidence: 0.9,
      explanation: 'Narration confirms the original payment.',
    });
    expect(result.rawResponse).toBe(validJson);
    expect(result.errorMessage).toBeNull();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns status timeout when the client rejects with LLMTimeoutError', async () => {
    const client: GeminiClient = vi.fn().mockRejectedValue(new LLMTimeoutError());

    const result = await investigate(bundle, client);

    expect(result.status).toBe('timeout');
    expect(result.classification).toBeNull();
    expect(result.rawResponse).toBeNull();
    expect(result.errorMessage).toMatch(/timed out/i);
  });

  it('returns status error when the client rejects with a generic/API error', async () => {
    const client: GeminiClient = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));

    const result = await investigate(bundle, client);

    expect(result.status).toBe('error');
    expect(result.classification).toBeNull();
    expect(result.rawResponse).toBeNull();
    expect(result.errorMessage).toContain('503');
  });

  it('returns status invalid_output but PRESERVES rawResponse when the model returns malformed JSON', async () => {
    const garbledText = 'not valid json at all {{{';
    const client: GeminiClient = vi.fn().mockResolvedValue({ text: garbledText });

    const result = await investigate(bundle, client);

    expect(result.status).toBe('invalid_output');
    expect(result.classification).toBeNull();
    expect(result.rawResponse).toBe(garbledText); // never discarded even on failure
    expect(result.errorMessage).toBeTruthy();
  });

  it('returns status invalid_output when JSON is well-formed but fails schema/semantic validation', async () => {
    const schemaViolating = JSON.stringify({
      classification: 'TOTALLY_MADE_UP',
      selectedTokens: [],
      confidence: 2, // out of range
      explanation: 'x',
    });
    const client: GeminiClient = vi.fn().mockResolvedValue({ text: schemaViolating });

    const result = await investigate(bundle, client);

    expect(result.status).toBe('invalid_output');
    expect(result.rawResponse).toBe(schemaViolating);
  });

  it('never imports or calls anything database-shaped - the signature takes only a bundle and an optional client', async () => {
    const client: GeminiClient = vi.fn().mockResolvedValue({
      text: JSON.stringify({ classification: 'INSUFFICIENT_EVIDENCE', selectedTokens: [], confidence: 0.1, explanation: 'x' }),
    });

    // investigate() called with exactly the public (bundle) signature works fine.
    await expect(investigate(bundle, client)).resolves.toMatchObject({ status: 'success' });
  });
});
