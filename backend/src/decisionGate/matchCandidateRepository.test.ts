import { describe, expect, it, vi } from 'vitest';
import { getPool } from '../db/pool';
import { linkCompositeGroup, upsertMatchCandidate } from './matchCandidateRepository';

vi.mock('../db/pool', () => ({ getPool: vi.fn() }));

function baseInput(overrides: Partial<Parameters<typeof upsertMatchCandidate>[0]> = {}) {
  return {
    settlementId: 501,
    ledgerOrderId: 42,
    isComposite: false,
    fsScore: null,
    route: 'auto_resolve' as const,
    algorithmVersion: 'v1',
    ...overrides,
  };
}

describe('upsertMatchCandidate', () => {
  it('inserts via ON DUPLICATE KEY UPDATE when ledgerOrderId is non-null, and returns the id', async () => {
    const query = vi.fn().mockResolvedValue([{ insertId: 77 }, []]);
    vi.mocked(getPool).mockReturnValue({ query } as never);

    const id = await upsertMatchCandidate(baseInput());

    expect(id).toBe(77);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/ON DUPLICATE KEY UPDATE/i);
    expect(params).toEqual([501, 42, false, null, 'auto_resolve', 'v1']);
  });

  it('looks up an existing row first when ledgerOrderId is null, and does not insert if found', async () => {
    const query = vi.fn().mockResolvedValue([[{ id: 88 }], []]);
    vi.mocked(getPool).mockReturnValue({ query } as never);

    const id = await upsertMatchCandidate(baseInput({ ledgerOrderId: null }));

    expect(id).toBe(88);
    expect(query).toHaveBeenCalledTimes(1); // only the SELECT - no INSERT needed
    expect(query.mock.calls[0][0]).toMatch(/SELECT id FROM match_candidates/i);
  });

  it('inserts a fresh row when ledgerOrderId is null and no existing row is found', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[], []]) // SELECT finds nothing
      .mockResolvedValueOnce([{ insertId: 99 }, []]); // INSERT
    vi.mocked(getPool).mockReturnValue({ query } as never);

    const id = await upsertMatchCandidate(baseInput({ ledgerOrderId: null }));

    expect(id).toBe(99);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toMatch(/INSERT INTO match_candidates/i);
  });
});

describe('linkCompositeGroup', () => {
  it('sets composite_group_id to the lowest id among the group', async () => {
    const query = vi.fn().mockResolvedValue([{}, []]);
    vi.mocked(getPool).mockReturnValue({ query } as never);

    await linkCompositeGroup([15, 12, 20]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE match_candidates SET composite_group_id/i);
    expect(params).toEqual([12, [15, 12, 20]]);
  });

  it('is a no-op for fewer than 2 ids', async () => {
    const query = vi.fn();
    vi.mocked(getPool).mockReturnValue({ query } as never);

    await linkCompositeGroup([5]);
    await linkCompositeGroup([]);

    expect(query).not.toHaveBeenCalled();
  });
});
