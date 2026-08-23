import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getPool } from '../db/pool';
import { insertAuditEvent } from '../audit/auditRepository';
import { enqueueForReview } from './reviewQueue';

vi.mock('../db/pool', () => ({ getPool: vi.fn() }));
vi.mock('../audit/auditRepository', () => ({ insertAuditEvent: vi.fn(async () => {}) }));

beforeEach(() => {
  vi.mocked(insertAuditEvent).mockClear();
});

function createFakeConnection(insertId = 55) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.toUpperCase().includes('INSERT INTO REVIEW_QUEUE')) {
        return [{ insertId }, []];
      }
      throw new Error(`Unmocked query: ${sql} ${JSON.stringify(params)}`);
    }),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(() => {}),
  };
}

describe('enqueueForReview', () => {
  it('inserts a pending review_queue row with the given fields', async () => {
    const conn = createFakeConnection(55);
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn(async () => conn) } as never);

    await enqueueForReview({ matchCandidateId: 10, reasonCode: 'fs_score_in_review_band', exposureAmount: 5000, priorityScore: 3200 });

    const [sql, params] = conn.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO review_queue/i);
    expect(sql).toMatch(/'pending'/);
    expect(params).toEqual([10, 'fs_score_in_review_band', 5000, 3200]);
  });

  it('calls insertAuditEvent with entityType match_candidate, the matchCandidateId, and DECISION_GATE actor', async () => {
    const conn = createFakeConnection(55);
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn(async () => conn) } as never);

    await enqueueForReview({ matchCandidateId: 10, reasonCode: 'ai_timeout', exposureAmount: 100, priorityScore: 70 });

    expect(insertAuditEvent).toHaveBeenCalledTimes(1);
    const [event, passedConnection] = vi.mocked(insertAuditEvent).mock.calls[0];
    expect(event).toMatchObject({
      entityType: 'match_candidate',
      entityId: 10,
      stage: 'decision_gate',
      actorType: 'DECISION_GATE',
    });
    expect((event.decisionGateOutput as Record<string, unknown>).reviewQueueId).toBe(55);
    expect(passedConnection).toBe(conn); // same transaction
  });

  it('commits on success and releases the connection', async () => {
    const conn = createFakeConnection();
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn(async () => conn) } as never);

    await enqueueForReview({ matchCandidateId: 1, reasonCode: 'x', exposureAmount: 1, priorityScore: 1 });

    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back, releases, and rethrows on failure, without ever calling insertAuditEvent', async () => {
    const conn = {
      query: vi.fn(async () => {
        throw new Error('insert failed');
      }),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(() => {}),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn(async () => conn) } as never);
    vi.mocked(insertAuditEvent).mockClear();

    await expect(enqueueForReview({ matchCandidateId: 1, reasonCode: 'x', exposureAmount: 1, priorityScore: 1 })).rejects.toThrow(
      'insert failed',
    );

    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(insertAuditEvent).not.toHaveBeenCalled();
  });

  it('throws immediately (no DB call at all) when matchCandidateId is null', async () => {
    const getConnection = vi.fn();
    vi.mocked(getPool).mockReturnValue({ getConnection } as never);

    await expect(
      enqueueForReview({ matchCandidateId: null, reasonCode: 'x', exposureAmount: 1, priorityScore: 1 }),
    ).rejects.toThrow(/must not be null/);

    expect(getConnection).not.toHaveBeenCalled();
  });
});
