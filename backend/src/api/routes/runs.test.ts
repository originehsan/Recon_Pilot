import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { getPool } from '../../db/pool';
import { orchestrateBatch } from '../../decisionGate/orchestrate';
import app from '../../app';

vi.mock('../../db/pool', () => ({ getPool: vi.fn() }));

// processRunAsync (fire-and-forget, kicked off the moment POST /runs
// responds) reaches all of these - mocked so it never makes a real DB/AI
// call even though the route handler doesn't await it.
vi.mock('../../matching/dbLoader', () => ({ loadSettlementsAndOrders: vi.fn(async () => ({ settlements: [], orders: [] })) }));
vi.mock('../../matching/groundTruth', () => ({ loadGroundTruth: vi.fn(() => []) }));
vi.mock('../../matching/runFullPipeline', () => ({
  runFullPipeline: vi.fn(() => ({ routedCases: [], thresholds: { upper: 1, lower: 0 } })),
}));
vi.mock('../../decisionGate/orchestrate', () => ({ orchestrateBatch: vi.fn(async () => ({ finalized: 0, reviewQueued: 0, failed: 0 })) }));
vi.mock('../../aiInvestigation/investigate', () => ({ investigate: vi.fn() }));

/** Matches every SQL statement runs.ts (POST /runs + its background work + GET /runs/:id) can issue. */
function createFakePool(options: { existingActiveRun?: number | null } = {}) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const batchRunRow = { id: 42, status: 'completed', progress: '{"totalCases":0,"processed":0,"resolved":0,"reviewQueued":0,"failed":0}', started_at: null, completed_at: null };

  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      if (normalized.startsWith("SELECT ID FROM BATCH_RUNS WHERE STATUS IN")) {
        return options.existingActiveRun ? [[{ id: options.existingActiveRun }], []] : [[], []];
      }
      if (normalized.startsWith('INSERT INTO BATCH_RUNS')) {
        return [{ insertId: 7 }, []];
      }
      if (normalized.startsWith('UPDATE BATCH_RUNS')) {
        updates.push({ sql, params });
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith('SELECT ID FROM BATCH_RUNS WHERE ID')) {
        return [[{ id: 42 }], []];
      }
      if (normalized.startsWith('SELECT * FROM BATCH_RUNS WHERE ID')) {
        return params[0] === 999 ? [[], []] : [[batchRunRow], []];
      }
      throw new Error(`Unmocked query in fake pool: ${sql}`);
    }),
  };

  return { pool, updates };
}

describe('POST /api/runs', () => {
  beforeEach(() => {
    vi.mocked(orchestrateBatch).mockClear();
  });

  it('returns 202 and a pending status when no run is already active', async () => {
    const { pool } = createFakePool({ existingActiveRun: null });
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app).post('/api/runs').send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: 7, status: 'pending' });
  });

  it('returns 409 with the existing run id when a run is already pending/processing', async () => {
    const { pool } = createFakePool({ existingActiveRun: 13 });
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app).post('/api/runs').send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A run is already in progress', existingRunId: 13 });
  });
});

describe('GET /api/runs/:id', () => {
  it('returns 404 for an unknown run id', async () => {
    const { pool } = createFakePool();
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app).get('/api/runs/999');

    expect(res.status).toBe(404);
  });

  it('returns the run status for a known run id', async () => {
    const { pool } = createFakePool();
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app).get('/api/runs/42');

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(42);
    expect(res.body.status).toBe('completed');
  });
});

describe('GET /api/runs/:id/exceptions', () => {
  it('returns 404 for an unknown run id', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();
        if (normalized.startsWith('SELECT ID FROM BATCH_RUNS WHERE ID')) return [[], []];
        throw new Error(`Unmocked query: ${sql}`);
      }),
    };
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app).get('/api/runs/999/exceptions');

    expect(res.status).toBe(404);
  });

  it('returns pending review_queue entries joined with settlement details for a known run id', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();
        if (normalized.startsWith('SELECT ID FROM BATCH_RUNS WHERE ID')) return [[{ id: 42 }], []];
        if (normalized.startsWith('SELECT RQ.ID AS REVIEWID')) {
          return [
            [
              {
                reviewId: 1,
                reasonCode: 'fs_score_in_review_band',
                exposureAmount: '1000.00',
                priorityScore: '500.00000000',
                status: 'pending',
                createdAt: new Date('2026-01-01'),
                settlementEntityId: 'pay_xyz',
                settlementAmount: '1000.00',
                narration: null,
              },
            ],
            [],
          ];
        }
        throw new Error(`Unmocked query: ${sql}`);
      }),
    };
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app).get('/api/runs/42/exceptions');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ reviewId: 1, settlementEntityId: 'pay_xyz', status: 'pending' });
  });
});
