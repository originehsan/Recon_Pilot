import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { getPool } from '../../db/pool';
import { finalizeCase, getCurrentResolutionId } from '../../decisionGate/decisionGate';
import app from '../../app';

vi.mock('../../db/pool', () => ({ getPool: vi.fn() }));

// Per the prompt's own guidance for this test file: mock finalizeCase
// itself rather than requiring a real DB transaction - decisionGate.test.ts
// already covers finalizeCase's own transactional correctness in depth.
vi.mock('../../decisionGate/decisionGate', () => ({
  finalizeCase: vi.fn(async (input: { settlementIds: number[]; finalStatus: string; reasonCode: string }) => ({
    settlementId: input.settlementIds[0],
    ledgerOrderId: null,
    finalStatus: input.finalStatus,
    decidedBy: 'human',
    matchCandidateId: 10,
    aiInvestigationId: null,
    evidenceVersion: 1,
    evidenceHash: 'fakehash',
    reasonCode: input.reasonCode,
  })),
  getCurrentResolutionId: vi.fn(async () => 555),
}));

const REVIEW_QUEUE_ROW = { id: 1, match_candidate_id: 10, status: 'pending', settlement_id: 20 };

function createFakePool(overrides: { reviewQueueRow?: typeof REVIEW_QUEUE_ROW | null } = {}) {
  const updates: unknown[][] = [];
  const row = overrides.reviewQueueRow === undefined ? REVIEW_QUEUE_ROW : overrides.reviewQueueRow;

  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      if (normalized.startsWith('SELECT RQ.ID, RQ.MATCH_CANDIDATE_ID')) {
        return [row ? [row] : [], []];
      }
      if (normalized.startsWith('UPDATE REVIEW_QUEUE')) {
        updates.push(params);
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unmocked query in fake pool: ${sql}`);
    }),
  };

  return { pool, updates };
}

describe('POST /api/exceptions/:id/resolve', () => {
  beforeEach(() => {
    vi.mocked(finalizeCase).mockClear();
    vi.mocked(getCurrentResolutionId).mockClear();
  });

  it('approve_match calls finalizeCase with matched/human/human_approved_match', async () => {
    const { pool, updates } = createFakePool();
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app)
      .post('/api/exceptions/1/resolve')
      .send({ action: 'approve_match', ledgerOrderId: 99 });

    expect(res.status).toBe(200);
    expect(finalizeCase).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementIds: [20],
        ledgerOrderId: 99,
        finalStatus: 'matched',
        decidedBy: 'human',
        matchCandidateId: 10,
        reasonCode: 'human_approved_match',
      }),
    );
    expect(updates[0]).toEqual(['resolved', 555, 1]);
  });

  it('reject calls finalizeCase with rejected/human/human_rejected and a null ledgerOrderId', async () => {
    const { pool } = createFakePool();
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app)
      .post('/api/exceptions/1/resolve')
      .send({ action: 'reject', ledgerOrderId: 99 }); // ledgerOrderId in the body is ignored for reject

    expect(res.status).toBe(200);
    expect(finalizeCase).toHaveBeenCalledWith(
      expect.objectContaining({ ledgerOrderId: null, finalStatus: 'rejected', decidedBy: 'human', reasonCode: 'human_rejected' }),
    );
  });

  it('mark_unresolved calls finalizeCase with unresolved/human/human_marked_unresolved', async () => {
    const { pool } = createFakePool();
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app)
      .post('/api/exceptions/1/resolve')
      .send({ action: 'mark_unresolved', ledgerOrderId: null });

    expect(res.status).toBe(200);
    expect(finalizeCase).toHaveBeenCalledWith(
      expect.objectContaining({ ledgerOrderId: null, finalStatus: 'unresolved', decidedBy: 'human', reasonCode: 'human_marked_unresolved' }),
    );
  });

  it('returns 404 when the review_queue row does not exist', async () => {
    const { pool } = createFakePool({ reviewQueueRow: null });
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app)
      .post('/api/exceptions/999/resolve')
      .send({ action: 'reject', ledgerOrderId: null });

    expect(res.status).toBe(404);
    expect(finalizeCase).not.toHaveBeenCalled();
  });

  it('returns 404 when the review_queue row is no longer pending', async () => {
    const { pool } = createFakePool({ reviewQueueRow: { ...REVIEW_QUEUE_ROW, status: 'resolved' } });
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app)
      .post('/api/exceptions/1/resolve')
      .send({ action: 'reject', ledgerOrderId: null });

    expect(res.status).toBe(404);
    expect(finalizeCase).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid action', async () => {
    const { pool } = createFakePool();
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app)
      .post('/api/exceptions/1/resolve')
      .send({ action: 'not_a_real_action', ledgerOrderId: null });

    expect(res.status).toBe(400);
  });
});
