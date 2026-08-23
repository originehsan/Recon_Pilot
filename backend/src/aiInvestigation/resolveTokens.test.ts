import { describe, expect, it } from 'vitest';
import { resolveTokens } from './resolveTokens';
import { AIInvestigationResult } from './investigate';

function successResult(selectedTokens: string[]): AIInvestigationResult {
  return {
    status: 'success',
    classification: {
      classification: selectedTokens.length > 1 ? 'MULTIPLE_MATCH_FOUND' : 'MATCH_FOUND',
      selectedTokens,
      confidence: 0.9,
      explanation: 'x',
    },
    rawResponse: '{}',
    latencyMs: 100,
    errorMessage: null,
  };
}

describe('resolveTokens', () => {
  it('resolves a single token to its real settlement id', () => {
    const map = new Map([
      ['CANDIDATE_A', 501],
      ['CANDIDATE_B', 502],
    ]);

    expect(resolveTokens(map, successResult(['CANDIDATE_B']))).toEqual([502]);
  });

  it('resolves multiple tokens, preserving order', () => {
    const map = new Map([
      ['CANDIDATE_A', 501],
      ['CANDIDATE_B', 502],
    ]);

    expect(resolveTokens(map, successResult(['CANDIDATE_B', 'CANDIDATE_A']))).toEqual([502, 501]);
  });

  it('returns an empty array for a non-success result', () => {
    const map = new Map([['CANDIDATE_A', 501]]);
    const failed: AIInvestigationResult = {
      status: 'timeout',
      classification: null,
      rawResponse: null,
      latencyMs: 10000,
      errorMessage: 'timed out',
    };

    expect(resolveTokens(map, failed)).toEqual([]);
  });

  it('returns an empty array when selectedTokens is empty (e.g. INSUFFICIENT_EVIDENCE)', () => {
    const map = new Map([['CANDIDATE_A', 501]]);

    expect(resolveTokens(map, successResult([]))).toEqual([]);
  });

  it('throws a clear error naming the offending token when it does not exist in the map', () => {
    const map = new Map([['CANDIDATE_A', 501]]);

    expect(() => resolveTokens(map, successResult(['CANDIDATE_Z']))).toThrow(/CANDIDATE_Z/);
  });
});
