import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getPool } from '../db/pool';
import { insertAuditEvent } from '../audit/auditRepository';
import { finalizeCase, FinalizeInput } from './decisionGate';

vi.mock('../db/pool', () => ({ getPool: vi.fn() }));
vi.mock('../audit/auditRepository', () => ({ insertAuditEvent: vi.fn(async () => {}) }));

interface FakeResolutionRow {
  id: number;
  settlement_id: number;
  ledger_order_id: number | null;
  match_candidate_id: number | null;
  ai_investigation_id: number | null;
  final_status: string;
  decided_by: string;
  evidence_version: number;
  evidence_hash: string;
  supersedes_resolution_id: number | null;
}

/**
 * A stateful, lock-aware fake for mysql2's pool/connection, built specifically
 * to prove finalizeCase's transactional logic is correct under true
 * serialization - it does NOT prove real MySQL row locking behaves this way
 * (that would need a real-DB integration test, out of scope for a
 * DB-free unit suite). What this DOES prove: given the serialization a real
 * `SELECT ... FOR UPDATE` provides, the idempotent/superseding logic never
 * produces two rows for one outcome.
 *
 * Locking: a per-settlementId promise queue. Acquiring a lock only resolves
 * once whatever's ahead of it in the queue has released (on commit or
 * rollback) - i.e. it faithfully serializes two "concurrent" finalizeCase
 * calls touching the same settlement, exactly like a real FOR UPDATE would
 * force the second transaction to wait for the first to finish.
 */
function createTestDb(existingSettlementIds: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  const resolutions: FakeResolutionRow[] = [];
  const settlementIds = new Set(existingSettlementIds);
  let nextResolutionId = 1;
  const lockQueues = new Map<number, Promise<void>>();

  function acquireLock(settlementId: number): { wait: Promise<void>; release: () => void } {
    const previous = lockQueues.get(settlementId) ?? Promise.resolve();
    let release!: () => void;
    const thisLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    lockQueues.set(settlementId, thisLock); // the NEXT requester waits on me
    return { wait: previous, release }; // I wait on whoever was here before me
  }

  function createConnection() {
    const heldLockReleases: Array<() => void> = [];

    return {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();

        if (normalized.startsWith('SELECT ID FROM INGESTED_SETTLEMENTS')) {
          const settlementId = params[0] as number;
          const { wait, release } = acquireLock(settlementId);
          await wait;
          heldLockReleases.push(release);
          if (!settlementIds.has(settlementId)) return [[], []];
          return [[{ id: settlementId }], []];
        }

        if (normalized.startsWith('SELECT R.* FROM RESOLUTIONS')) {
          const settlementId = params[0] as number;
          const supersededIds = new Set(
            resolutions.filter((r) => r.supersedes_resolution_id !== null).map((r) => r.supersedes_resolution_id),
          );
          const heads = resolutions
            .filter((r) => r.settlement_id === settlementId && !supersededIds.has(r.id))
            .sort((a, b) => b.id - a.id);
          return [heads.slice(0, 1), []];
        }

        if (normalized.startsWith('INSERT INTO RESOLUTIONS')) {
          const p = params as [number, number | null, number | null, number | null, string, string, number, string, number | null];
          const row: FakeResolutionRow = {
            id: nextResolutionId++,
            settlement_id: p[0],
            ledger_order_id: p[1],
            match_candidate_id: p[2],
            ai_investigation_id: p[3],
            final_status: p[4],
            decided_by: p[5],
            evidence_version: p[6],
            evidence_hash: p[7],
            supersedes_resolution_id: p[8],
          };
          resolutions.push(row);
          return [{ insertId: row.id }, []];
        }

        if (normalized.startsWith('SELECT * FROM AI_INVESTIGATIONS')) {
          return [[{ id: params[0], classification: 'MATCH_FOUND' }], []];
        }

        throw new Error(`Unmocked query in fake connection: ${sql}`);
      }),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {
        for (const release of heldLockReleases.splice(0)) release();
      }),
      rollback: vi.fn(async () => {
        for (const release of heldLockReleases.splice(0)) release();
      }),
      release: vi.fn(() => {}),
    };
  }

  const connectionsIssued: ReturnType<typeof createConnection>[] = [];
  const fakePool = {
    getConnection: vi.fn(async () => {
      const conn = createConnection();
      connectionsIssued.push(conn);
      return conn;
    }),
  };

  return { fakePool, resolutions, connectionsIssued };
}

function makeInput(overrides: Partial<FinalizeInput> = {}): FinalizeInput {
  return {
    settlementIds: [1],
    ledgerOrderId: 100,
    finalStatus: 'matched',
    decidedBy: 'stage1_exact',
    matchCandidateId: null,
    aiInvestigationId: null,
    evidenceVersion: 1,
    evidence: { note: 'exact match' },
    reasonCode: 'exact_id_and_amount_match',
    ...overrides,
  };
}

describe('finalizeCase', () => {
  beforeEach(() => {
    vi.mocked(insertAuditEvent).mockClear();
  });

  it('a fresh finalize succeeds and inserts exactly one resolution row', async () => {
    const { fakePool, resolutions } = createTestDb();
    vi.mocked(getPool).mockReturnValue(fakePool as never);

    const decision = await finalizeCase(makeInput());

    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      settlement_id: 1,
      ledger_order_id: 100,
      final_status: 'matched',
      supersedes_resolution_id: null,
    });
    expect(decision.settlementId).toBe(1);
    expect(decision.finalStatus).toBe('matched');
    expect(insertAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('calling finalizeCase twice with identical input produces exactly one resolution row AND exactly one audit event', async () => {
    const { fakePool, resolutions } = createTestDb();
    vi.mocked(getPool).mockReturnValue(fakePool as never);

    const first = await finalizeCase(makeInput());
    const second = await finalizeCase(makeInput());

    expect(resolutions).toHaveLength(1); // still just one row - no duplicate
    expect(second.evidenceHash).toBe(first.evidenceHash);
    // REVISED: a pure no-op re-finalization must NOT write a second audit
    // event. Confirmed live before this fix: resolution id 1 in the real
    // dev DB had 13 audit_events rows (12 of them `allNoOp: true`) from 12
    // separate re-runs re-scanning the same already-resolved settlement -
    // exactly this scenario, just repeated many more times. Only the first,
    // genuine finalization gets logged.
    expect(insertAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('calling finalizeCase a third time (still identical) does not add a third audit event either', async () => {
    const { fakePool, resolutions } = createTestDb();
    vi.mocked(getPool).mockReturnValue(fakePool as never);

    await finalizeCase(makeInput());
    await finalizeCase(makeInput());
    await finalizeCase(makeInput());

    expect(resolutions).toHaveLength(1);
    expect(insertAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('logs a fresh audit event when a later call genuinely supersedes a prior no-op-checked resolution', async () => {
    const { fakePool, resolutions } = createTestDb();
    vi.mocked(getPool).mockReturnValue(fakePool as never);

    await finalizeCase(makeInput({ finalStatus: 'matched' })); // 1st audit event
    await finalizeCase(makeInput({ finalStatus: 'matched' })); // no-op, no audit event
    await finalizeCase(makeInput({ finalStatus: 'rejected', reasonCode: 'correction' })); // genuine change, 2nd audit event

    expect(resolutions).toHaveLength(2);
    expect(insertAuditEvent).toHaveBeenCalledTimes(2);
  });

  it('calling finalizeCase with a different finalStatus creates a properly-superseding second row', async () => {
    const { fakePool, resolutions } = createTestDb();
    vi.mocked(getPool).mockReturnValue(fakePool as never);

    await finalizeCase(makeInput({ finalStatus: 'matched' }));
    const second = await finalizeCase(makeInput({ finalStatus: 'rejected', reasonCode: 'correction' }));

    expect(resolutions).toHaveLength(2);
    expect(resolutions[1].supersedes_resolution_id).toBe(resolutions[0].id);
    expect(second.finalStatus).toBe('rejected');
  });

  it('inserts one resolution row per settlement for a multi-settlement composite finalize', async () => {
    const { fakePool, resolutions } = createTestDb();
    vi.mocked(getPool).mockReturnValue(fakePool as never);

    await finalizeCase(
      makeInput({ settlementIds: [1, 2, 3], decidedBy: 'stage7_auto', reasonCode: 'unique_subset_sum_match' }),
    );

    expect(resolutions).toHaveLength(3);
    expect(resolutions.map((r) => r.settlement_id).sort()).toEqual([1, 2, 3]);
    expect(resolutions.every((r) => r.final_status === 'matched')).toBe(true);
  });

  it('concurrent calls for the same settlement result in exactly one resolution row and one audit event, not two', async () => {
    const { fakePool, resolutions } = createTestDb();
    vi.mocked(getPool).mockReturnValue(fakePool as never);

    await Promise.all([finalizeCase(makeInput()), finalizeCase(makeInput())]);

    expect(resolutions).toHaveLength(1);
    expect(insertAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('passes the SAME connection to insertAuditEvent as the one used for the resolutions insert (same transaction)', async () => {
    const { fakePool, connectionsIssued } = createTestDb();
    vi.mocked(getPool).mockReturnValue(fakePool as never);

    await finalizeCase(makeInput());

    expect(insertAuditEvent).toHaveBeenCalledTimes(1);
    const auditCallConnection = vi.mocked(insertAuditEvent).mock.calls[0][1];
    expect(auditCallConnection).toBe(connectionsIssued[0]);
  });

  it('throws for an empty settlementIds array', async () => {
    const { fakePool } = createTestDb();
    vi.mocked(getPool).mockReturnValue(fakePool as never);

    await expect(finalizeCase(makeInput({ settlementIds: [] }))).rejects.toThrow();
  });

  it('throws and inserts nothing if a settlement does not exist', async () => {
    const { fakePool, resolutions } = createTestDb([1, 2, 3]); // 999 not in this set
    vi.mocked(getPool).mockReturnValue(fakePool as never);

    await expect(finalizeCase(makeInput({ settlementIds: [999] }))).rejects.toThrow(/does not exist/);
    expect(resolutions).toHaveLength(0);
  });

  it('releases the connection even when it throws', async () => {
    const { fakePool, connectionsIssued } = createTestDb([1, 2, 3]);
    vi.mocked(getPool).mockReturnValue(fakePool as never);

    await expect(finalizeCase(makeInput({ settlementIds: [999] }))).rejects.toThrow();

    expect(connectionsIssued[0].release).toHaveBeenCalledTimes(1);
    expect(connectionsIssued[0].rollback).toHaveBeenCalledTimes(1);
    expect(connectionsIssued[0].commit).not.toHaveBeenCalled();
  });
});
