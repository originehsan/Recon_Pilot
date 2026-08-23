import { describe, expect, it, vi } from 'vitest';
import { getPool } from '../db/pool';
import { insertAuditEvent, AuditEventInput } from './auditRepository';

vi.mock('../db/pool', () => ({ getPool: vi.fn() }));

interface FakeAuditRow {
  entity_type: string;
  entity_id: number;
  sequence_no: number;
  stage: string;
}

function baseEvent(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    entityType: 'settlement',
    entityId: 501,
    stage: 'stage1_exact',
    actorType: 'SYSTEM',
    evidenceUsed: null,
    aiRawOutput: null,
    decisionGateOutput: null,
    ...overrides,
  };
}

/**
 * Stateful fake: a real in-memory "audit_events" table, so the
 * sequence-number tests actually exercise MAX(sequence_no)+1 logic across
 * repeated calls, not just canned per-call return values.
 */
function createFakePool(table: FakeAuditRow[]) {
  function createConnection() {
    return {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();

        if (normalized.startsWith('SELECT COALESCE(MAX(SEQUENCE_NO)')) {
          const [entityType, entityId] = params as [string, number];
          const matching = table.filter((r) => r.entity_type === entityType && r.entity_id === entityId);
          const nextSeq = matching.length === 0 ? 1 : Math.max(...matching.map((r) => r.sequence_no)) + 1;
          return [[{ nextSeq }], []];
        }

        if (normalized.startsWith('INSERT INTO AUDIT_EVENTS')) {
          const p = params as [string, number, string, string, unknown, unknown, unknown, number];
          table.push({ entity_type: p[0], entity_id: p[1], stage: p[2], sequence_no: p[7] });
          return [{ insertId: table.length }, []];
        }

        throw new Error(`Unmocked query in fake connection: ${sql}`);
      }),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(() => {}),
    };
  }

  return { getConnection: vi.fn(async () => createConnection()) };
}

describe('insertAuditEvent', () => {
  it('assigns sequential sequence_no values (1, 2, 3, ...) for repeated events on the same entity', async () => {
    const table: FakeAuditRow[] = [];
    vi.mocked(getPool).mockReturnValue(createFakePool(table) as never);

    for (let i = 0; i < 3; i++) {
      await insertAuditEvent(baseEvent({ stage: `stage_${i}` }));
    }

    expect(table.map((r) => r.sequence_no)).toEqual([1, 2, 3]);
  });

  it('tracks sequence_no independently per entity (entityType+entityId pair)', async () => {
    const table: FakeAuditRow[] = [];
    vi.mocked(getPool).mockReturnValue(createFakePool(table) as never);

    await insertAuditEvent(baseEvent({ entityId: 501 }));
    await insertAuditEvent(baseEvent({ entityId: 502 }));
    await insertAuditEvent(baseEvent({ entityId: 501 }));

    expect(table.filter((r) => r.entity_id === 501).map((r) => r.sequence_no)).toEqual([1, 2]);
    expect(table.filter((r) => r.entity_id === 502).map((r) => r.sequence_no)).toEqual([1]);
  });

  it('opens, commits, and releases its own transaction when no connection is supplied', async () => {
    const conn = {
      query: vi.fn(async (sql: string) =>
        sql.toUpperCase().includes('MAX(SEQUENCE_NO)') ? [[{ nextSeq: 1 }], []] : [{ insertId: 1 }, []],
      ),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(() => {}),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn(async () => conn) } as never);

    await insertAuditEvent(baseEvent());

    expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases if the insert fails, and rethrows', async () => {
    const conn = {
      query: vi.fn(async (sql: string) => {
        if (sql.toUpperCase().includes('MAX(SEQUENCE_NO)')) return [[{ nextSeq: 1 }], []];
        throw new Error('insert failed');
      }),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(() => {}),
    };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn(async () => conn) } as never);

    await expect(insertAuditEvent(baseEvent())).rejects.toThrow('insert failed');

    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('participates in a caller-provided connection without managing its own transaction', async () => {
    const conn = {
      query: vi.fn(async (sql: string) =>
        sql.toUpperCase().includes('MAX(SEQUENCE_NO)') ? [[{ nextSeq: 1 }], []] : [{ insertId: 1 }, []],
      ),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(() => {}),
    };

    await insertAuditEvent(baseEvent({ entityType: 'resolution', stage: 'decision_gate', actorType: 'DECISION_GATE' }), conn as never);

    expect(conn.beginTransaction).not.toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).not.toHaveBeenCalled();
    expect(conn.query).toHaveBeenCalled();
  });

  it('never merges aiRawOutput and decisionGateOutput into a single field', async () => {
    const conn = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.toUpperCase().includes('MAX(SEQUENCE_NO)')) return [[{ nextSeq: 1 }], []];
        // Capture the INSERT params to assert on below.
        (conn as { lastInsertParams?: unknown[] }).lastInsertParams = params;
        return [{ insertId: 1 }, []];
      }),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(() => {}),
      lastInsertParams: undefined as unknown[] | undefined,
    };

    await insertAuditEvent(
      baseEvent({ aiRawOutput: { classification: 'MATCH_FOUND' }, decisionGateOutput: { finalStatus: 'matched' } }),
      conn as never,
    );

    const params = conn.lastInsertParams!;
    // INSERT column order: entity_type, entity_id, stage, actor_type,
    // evidence_used, ai_raw_output, decision_gate_output, sequence_no
    expect(JSON.parse(params[5] as string)).toEqual({ classification: 'MATCH_FOUND' });
    expect(JSON.parse(params[6] as string)).toEqual({ finalStatus: 'matched' });
  });
});
