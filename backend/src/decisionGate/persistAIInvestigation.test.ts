import { describe, expect, it, vi } from 'vitest';
import { getPool } from '../db/pool';
import { persistAIInvestigationResult } from './persistAIInvestigation';
import { EvidenceBundle } from '../aiInvestigation/evidenceBundle';
import { AIInvestigationResult } from '../aiInvestigation/investigate';

vi.mock('../db/pool', () => ({ getPool: vi.fn() }));

const bundle: EvidenceBundle = {
  caseType: 'ambiguous_duplicate',
  orderContext: { expectedAmount: 1000, currency: 'INR' },
  candidates: [
    { token: 'CANDIDATE_A', amount: 1000, fee: 20, tax: 4, creditType: 'default', hasDispute: false, narration: 'x' },
  ],
};

describe('persistAIInvestigationResult', () => {
  it('inserts a successful result with classification and confidence populated', async () => {
    const query = vi.fn().mockResolvedValue([{ insertId: 42 }, []]);
    vi.mocked(getPool).mockReturnValue({ query } as never);

    const result: AIInvestigationResult = {
      status: 'success',
      classification: { classification: 'MATCH_FOUND', selectedTokens: ['CANDIDATE_A'], confidence: 0.95, explanation: 'x' },
      rawResponse: '{"classification":"MATCH_FOUND"}',
      latencyMs: 5000,
      errorMessage: null,
    };

    const id = await persistAIInvestigationResult(10, bundle, 1, result);

    expect(id).toBe(42);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_investigations/i);
    expect(params[0]).toBe(10); // matchCandidateId
    expect(JSON.parse(params[1] as string)).toEqual(bundle); // evidence_bundle
    expect(params[2]).toBe(1); // evidence_version
    expect(JSON.parse(params[3] as string)).toEqual({ text: result.rawResponse }); // wrapped for valid JSON
    expect(params[4]).toBe('MATCH_FOUND'); // classification
    expect(params[5]).toBe(0.95); // confidence
    expect(params[6]).toBe('success'); // status
  });

  it('wraps a garbled (non-JSON) rawResponse so the JSON column insert never fails', async () => {
    const query = vi.fn().mockResolvedValue([{ insertId: 1 }, []]);
    vi.mocked(getPool).mockReturnValue({ query } as never);

    const result: AIInvestigationResult = {
      status: 'invalid_output',
      classification: null,
      rawResponse: 'not valid json at all {{{',
      latencyMs: 1200,
      errorMessage: 'Response is not valid JSON',
    };

    await persistAIInvestigationResult(10, bundle, 1, result);

    const [, params] = query.mock.calls[0];
    // Must not throw here, and must be well-formed JSON once wrapped.
    expect(() => JSON.parse(params[3] as string)).not.toThrow();
    expect(JSON.parse(params[3] as string)).toEqual({ text: 'not valid json at all {{{' });
    expect(params[4]).toBeNull(); // no classification
    expect(params[5]).toBeNull(); // no confidence
  });

  it('stores null for raw_llm_response, classification, and confidence on a timeout/error', async () => {
    const query = vi.fn().mockResolvedValue([{ insertId: 2 }, []]);
    vi.mocked(getPool).mockReturnValue({ query } as never);

    const result: AIInvestigationResult = {
      status: 'timeout',
      classification: null,
      rawResponse: null,
      latencyMs: 20000,
      errorMessage: 'Gemini request timed out after 20000ms',
    };

    await persistAIInvestigationResult(10, bundle, 1, result);

    const [, params] = query.mock.calls[0];
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
    expect(params[5]).toBeNull();
    expect(params[6]).toBe('timeout');
  });

  it('reconstructs requested_at from completed_at minus latencyMs', async () => {
    const query = vi.fn().mockResolvedValue([{ insertId: 3 }, []]);
    vi.mocked(getPool).mockReturnValue({ query } as never);

    const result: AIInvestigationResult = {
      status: 'success',
      classification: { classification: 'INSUFFICIENT_EVIDENCE', selectedTokens: [], confidence: 0.1, explanation: 'x' },
      rawResponse: '{}',
      latencyMs: 10000,
      errorMessage: null,
    };

    const before = Date.now();
    await persistAIInvestigationResult(10, bundle, 1, result);

    const [, params] = query.mock.calls[0];
    const requestedAt = params[7] as Date;
    const completedAt = params[8] as Date;

    expect(completedAt.getTime() - requestedAt.getTime()).toBe(10000);
    expect(completedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});
