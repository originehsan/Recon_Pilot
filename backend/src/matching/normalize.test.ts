import { describe, expect, it } from 'vitest';
import { stripTypePrefix } from './normalize';

describe('stripTypePrefix', () => {
  it('splits a normal single-underscore id into prefix and suffix', () => {
    expect(stripTypePrefix('pay_ABC123')).toEqual({ prefix: 'pay', suffix: 'ABC123' });
  });

  it('treats an id with no underscore as having no prefix at all', () => {
    expect(stripTypePrefix('ABC123')).toEqual({ prefix: '', suffix: 'ABC123' });
  });

  it('splits only on the FIRST underscore when the id has multiple', () => {
    const result = stripTypePrefix('order_TM_5501');
    expect(result.prefix).toBe('order');
    // Must be "TM_5501", not "TM" - later underscores stay in the suffix.
    expect(result.suffix).toBe('TM_5501');
  });

  it('returns empty prefix and suffix for an empty string', () => {
    expect(stripTypePrefix('')).toEqual({ prefix: '', suffix: '' });
  });
});
