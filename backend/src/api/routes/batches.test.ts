import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { getPool } from '../../db/pool';
import app from '../../app';

vi.mock('../../db/pool', () => ({ getPool: vi.fn() }));

// Mocked so importing app.ts (which mounts every route, including runs.ts)
// never makes a real network/DB call, exactly like batches.ts's own tests
// only exercise POST /api/batches.
vi.mock('../../matching/dbLoader', () => ({ loadSettlementsAndOrders: vi.fn(async () => ({ settlements: [], orders: [] })) }));
vi.mock('../../matching/groundTruth', () => ({ loadGroundTruth: vi.fn(() => []) }));
vi.mock('../../matching/runFullPipeline', () => ({
  runFullPipeline: vi.fn(() => ({ routedCases: [], thresholds: { upper: 1, lower: 0 } })),
}));
vi.mock('../../decisionGate/orchestrate', () => ({ orchestrateBatch: vi.fn(async () => ({ finalized: 0, reviewQueued: 0, failed: 0 })) }));
vi.mock('../../aiInvestigation/investigate', () => ({ investigate: vi.fn() }));

/** A minimal fake pool: inspects the SQL text and returns a canned result. */
function createFakePool() {
  const insertedSettlements: unknown[][] = [];
  const insertedOrders: unknown[][] = [];

  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      if (normalized.startsWith('SELECT MAX(BATCH_ID)')) {
        return [[{ maxBatchId: 4 }], []];
      }
      if (normalized.startsWith('INSERT INTO INGESTED_SETTLEMENTS')) {
        insertedSettlements.push(params);
        return [{ insertId: insertedSettlements.length, affectedRows: 1 }, []];
      }
      if (normalized.startsWith('INSERT INTO LEDGER_ORDERS')) {
        insertedOrders.push(params);
        return [{ insertId: insertedOrders.length, affectedRows: 1 }, []];
      }
      throw new Error(`Unmocked query in fake pool: ${sql}`);
    }),
  };

  return { pool, insertedSettlements, insertedOrders };
}

function validSettlement(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    entityId: 'pay_abc123',
    type: 'settlement',
    settlementId: 'setl_abc123',
    settlementUtr: 'UTRABC123',
    orderId: 'order_abc123',
    paymentId: 'pay_abc123',
    amount: 100000,
    fee: 2000,
    tax: 360,
    onHold: false,
    disputeId: null,
    creditType: 'default',
    narration: null,
    ...overrides,
  };
}

function validOrder(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    orderId: 'order_abc123',
    expectedAmount: 102360,
    expectedReference: null,
    expectedDate: '2026-08-01',
    ...overrides,
  };
}

describe('POST /api/batches', () => {
  it('accepts a valid body and inserts settlements + orders under a new batch_id', async () => {
    const { pool } = createFakePool();
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app)
      .post('/api/batches')
      .send({ settlements: [validSettlement()], orders: [validOrder()] });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ batchId: 5, settlementsInserted: 1, ordersInserted: 1 });
  });

  it('rejects an invalid body (missing required fields) with a 400', async () => {
    const { pool } = createFakePool();
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app)
      .post('/api/batches')
      .send({ settlements: [], orders: [validOrder()] }); // settlements must have min 1

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('skips a within-batch duplicate content_hash instead of failing the whole batch', async () => {
    const { pool, insertedSettlements } = createFakePool();
    vi.mocked(getPool).mockReturnValue(pool as never);

    const duplicate = validSettlement();
    const res = await request(app)
      .post('/api/batches')
      .send({ settlements: [duplicate, { ...duplicate }], orders: [validOrder()] });

    expect(res.status).toBe(201);
    expect(res.body.settlementsInserted).toBe(1);
    expect(res.body.skippedSettlements).toEqual([{ index: 1, reason: 'duplicate_content_hash_in_batch' }]);
    expect(insertedSettlements).toHaveLength(1);
  });

  it('defaults batchId to 1 when ingested_settlements is empty', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();
        if (normalized.startsWith('SELECT MAX(BATCH_ID)')) return [[{ maxBatchId: null }], []];
        if (normalized.startsWith('INSERT INTO INGESTED_SETTLEMENTS')) return [{ insertId: 1 }, []];
        if (normalized.startsWith('INSERT INTO LEDGER_ORDERS')) return [{ insertId: 1 }, []];
        throw new Error(`Unmocked query: ${sql}`);
      }),
    };
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app)
      .post('/api/batches')
      .send({ settlements: [validSettlement()], orders: [validOrder()] });

    expect(res.body.batchId).toBe(1);
  });
});
