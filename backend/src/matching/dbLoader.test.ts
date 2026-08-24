// dbLoader.ts previously had no unit tests (every call site aside from
// backend/src/api/routes/runs.ts is a live-DB verification script by
// design - see this project's established convention: the "matching" DB-
// loading layer is verified live, not mocked). The new `excludeResolved`
// option is exactly the kind of logic error (right idea, wrong SQL, or a
// silently-ignored flag) that's cheap to catch here instead of live - so a
// minimal `poolOverride` hook was added specifically to make it possible,
// without touching how any of the 5 existing real call sites behave (all
// still create/own/close their own pool exactly as before).

import { describe, expect, it, vi } from 'vitest';
import { loadSettlementsAndOrders } from './dbLoader';

const ALL_SETTLEMENT_ROWS = [
  {
    id: 1,
    entity_id: 'pay_1',
    order_id: 'order_1',
    amount: '1000.00',
    fee: '20.00',
    tax: '4.00',
    settlement_utr: null,
    credit_type: 'default',
    dispute_id: null,
    narration: null,
  },
  {
    id: 2,
    entity_id: 'pay_2',
    order_id: 'order_2',
    amount: '2000.00',
    fee: '40.00',
    tax: '8.00',
    settlement_utr: null,
    credit_type: 'default',
    dispute_id: null,
    narration: null,
  },
];

// Simulates settlement id 1 already having a non-superseded resolution -
// i.e. what the real NOT EXISTS clause would filter out against a real DB.
const UNRESOLVED_ONLY_ROWS = [ALL_SETTLEMENT_ROWS[1]];

const ORDER_ROWS = [
  { id: 1, order_id: 'order_1', expected_amount: '1000.00', expected_date: '2026-01-01' },
  { id: 2, order_id: 'order_2', expected_amount: '2000.00', expected_date: '2026-01-02' },
];

function createFakePool() {
  const queries: string[] = [];

  const pool = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      if (normalized.startsWith('SELECT ID, ENTITY_ID')) {
        // Mimics what the real SQL would actually return: presence of the
        // NOT EXISTS exclusion clause changes which rows come back.
        const excludesResolved = normalized.includes('NOT EXISTS');
        return [excludesResolved ? UNRESOLVED_ONLY_ROWS : ALL_SETTLEMENT_ROWS, []];
      }
      if (normalized.startsWith('SELECT ID, ORDER_ID, EXPECTED_AMOUNT')) {
        return [ORDER_ROWS, []];
      }
      throw new Error(`Unmocked query in fake pool: ${sql}`);
    }),
    end: vi.fn(async () => {}),
  };

  return { pool, queries };
}

describe('loadSettlementsAndOrders', () => {
  it('returns every settlement when excludeResolved is omitted (default, backward-compatible behavior)', async () => {
    const { pool } = createFakePool();

    const { settlements } = await loadSettlementsAndOrders({}, pool as never);

    expect(settlements).toHaveLength(2);
    expect(settlements.map((s) => s.id).sort()).toEqual([1, 2]);
  });

  it('does not close a caller-supplied pool override (only self-created pools get closed)', async () => {
    const { pool } = createFakePool();

    await loadSettlementsAndOrders({}, pool as never);

    expect(pool.end).not.toHaveBeenCalled();
  });

  it('includes a NOT EXISTS ... resolutions exclusion clause in the SQL when excludeResolved is true', async () => {
    const { pool, queries } = createFakePool();

    await loadSettlementsAndOrders({ excludeResolved: true }, pool as never);

    const settlementQuery = queries.find((q) => q.toUpperCase().includes('FROM INGESTED_SETTLEMENTS'));
    expect(settlementQuery).toBeDefined();
    expect(settlementQuery).toMatch(/NOT EXISTS/);
    expect(settlementQuery).toMatch(/resolutions/i);
  });

  it('omits the exclusion clause entirely when excludeResolved is false or omitted', async () => {
    const { pool, queries } = createFakePool();

    await loadSettlementsAndOrders({}, pool as never);

    const settlementQuery = queries.find((q) => q.toUpperCase().includes('FROM INGESTED_SETTLEMENTS'));
    expect(settlementQuery).toBeDefined();
    expect(settlementQuery).not.toMatch(/NOT EXISTS/);
  });

  it('excludes an already-resolved settlement from the returned array when excludeResolved is true', async () => {
    const { pool } = createFakePool();

    const { settlements } = await loadSettlementsAndOrders({ excludeResolved: true }, pool as never);

    // Directly protects the case count / quota risk this option exists for:
    // a settlement with a non-superseded resolution must not reappear as a
    // "case" in a fresh run, and (for an ai_investigation-routed case) must
    // never reach investigateFn again.
    expect(settlements).toHaveLength(1);
    expect(settlements[0].id).toBe(2);
  });

  it('never filters orders, regardless of excludeResolved (only settlements are settlement-resolution-scoped)', async () => {
    const { pool } = createFakePool();

    const { orders } = await loadSettlementsAndOrders({ excludeResolved: true }, pool as never);

    expect(orders).toHaveLength(2);
  });
});
