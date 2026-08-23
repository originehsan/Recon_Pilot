import { describe, expect, it } from 'vitest';
import { levenshteinDistance, normalizedSimilarity } from './stringSimilarity';

describe('levenshteinDistance', () => {
  it('is 0 for identical strings', () => {
    expect(levenshteinDistance('TM5501', 'TM5501')).toBe(0);
  });

  it('is the length of the other string when one side is empty', () => {
    expect(levenshteinDistance('abc', '')).toBe(3);
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('', '')).toBe(0);
  });

  it('counts a single substitution as distance 1', () => {
    expect(levenshteinDistance('TM5501', 'TM5502')).toBe(1);
  });

  it('counts a truncation as a deletion for each dropped character', () => {
    expect(levenshteinDistance('TM5501', 'TM55')).toBe(2);
  });
});

describe('normalizedSimilarity', () => {
  it('is 1 for identical strings', () => {
    expect(normalizedSimilarity('TM5501', 'TM5501')).toBe(1);
  });

  it('is 1 for two empty strings', () => {
    expect(normalizedSimilarity('', '')).toBe(1);
  });

  it('is 0 for completely different strings of equal length', () => {
    expect(normalizedSimilarity('abc', 'xyz')).toBe(0);
  });

  it('scores a realistic truncation case highly', () => {
    // "TM5501" -> "TM55": distance 2, max length 6 => 1 - 2/6 = 0.6667
    const similarity = normalizedSimilarity('TM5501', 'TM55');
    expect(similarity).toBeCloseTo(1 - 2 / 6, 10);
    expect(similarity).toBeGreaterThan(0.6);
  });

  it('scores a realistic single-substitution case highly', () => {
    // "TM5501" -> "TM5502": distance 1, max length 6 => 1 - 1/6 = 0.8333
    const similarity = normalizedSimilarity('TM5501', 'TM5502');
    expect(similarity).toBeCloseTo(1 - 1 / 6, 10);
    expect(similarity).toBeGreaterThan(0.8);
  });

  it('is 0 when one string is empty and the other is not', () => {
    expect(normalizedSimilarity('abc', '')).toBe(0);
  });
});
