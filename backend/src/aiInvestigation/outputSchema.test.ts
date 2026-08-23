import { describe, expect, it } from 'vitest';
import { validateAndParseOutput } from './outputSchema';

describe('validateAndParseOutput', () => {
  it('accepts valid output', () => {
    const raw = JSON.stringify({
      classification: 'MATCH_FOUND',
      selectedTokens: ['CANDIDATE_A'],
      confidence: 0.87,
      explanation: 'Narration confirms this is the original payment.',
    });

    const result = validateAndParseOutput(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.classification).toBe('MATCH_FOUND');
      expect(result.data.selectedTokens).toEqual(['CANDIDATE_A']);
      expect(result.data.confidence).toBe(0.87);
    }
  });

  it('accepts INSUFFICIENT_EVIDENCE with an empty selectedTokens array', () => {
    const raw = JSON.stringify({
      classification: 'INSUFFICIENT_EVIDENCE',
      selectedTokens: [],
      confidence: 0.2,
      explanation: 'Narration on both candidates is inconclusive.',
    });

    const result = validateAndParseOutput(raw);

    expect(result.success).toBe(true);
  });

  it('fails cleanly on malformed JSON', () => {
    const result = validateAndParseOutput('not valid json at all {{{');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/not valid JSON/i);
    }
  });

  it('fails cleanly on an empty string', () => {
    const result = validateAndParseOutput('');
    expect(result.success).toBe(false);
  });

  it('fails cleanly on a schema-violating enum value', () => {
    const raw = JSON.stringify({
      classification: 'DEFINITELY_A_MATCH', // not one of the four valid enum values
      selectedTokens: [],
      confidence: 0.5,
      explanation: 'x',
    });

    const result = validateAndParseOutput(raw);

    expect(result.success).toBe(false);
  });

  it('fails cleanly when confidence is out of the [0, 1] range', () => {
    const raw = JSON.stringify({
      classification: 'MATCH_FOUND',
      selectedTokens: ['CANDIDATE_A'],
      confidence: 1.5,
      explanation: 'x',
    });

    const result = validateAndParseOutput(raw);

    expect(result.success).toBe(false);
  });

  it('fails cleanly when a required field is missing', () => {
    const raw = JSON.stringify({ classification: 'MATCH_FOUND', selectedTokens: ['CANDIDATE_A'] });

    const result = validateAndParseOutput(raw);

    expect(result.success).toBe(false);
  });

  it('fails the semantic token check on an invented/unknown token even though z.string() alone would accept it', () => {
    const raw = JSON.stringify({
      classification: 'MATCH_FOUND',
      selectedTokens: ['definitely-not-a-real-token'], // any string passes pure Zod z.string() validation
      confidence: 0.9,
      explanation: 'x',
    });

    const result = validateAndParseOutput(raw);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/CANDIDATE_/);
    }
  });

  it('fails the semantic token check when only one of several tokens is invalid', () => {
    const raw = JSON.stringify({
      classification: 'MULTIPLE_MATCH_FOUND',
      selectedTokens: ['CANDIDATE_A', 'CANDIDATE_1'], // "1" is not [A-Z]+
      confidence: 0.6,
      explanation: 'x',
    });

    const result = validateAndParseOutput(raw);

    expect(result.success).toBe(false);
  });
});
