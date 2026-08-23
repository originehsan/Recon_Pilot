// Insert-only audit trail.
//
// Scope decisions (both deliberate, both noted here rather than silently
// assumed):
//   - No DB-grant-based immutability. A dedicated restricted MySQL user
//     that can only INSERT into audit_events (never UPDATE/DELETE) is out
//     of scope for this prompt due to setup time cost - the app continues
//     connecting as the existing configured user. Immutability is enforced
//     at the APPLICATION layer instead: this file exports exactly one
//     function, and no update/delete function for this table exists
//     anywhere in the codebase.
//   - No event-hash chaining (prev_event_hash linkage). Also out of scope.
//     Ordering within an entity's history is plain sequence_no + created_at,
//     nothing cryptographically linking one event to the next.

import mysql, { PoolConnection } from 'mysql2/promise';
import { getPool } from '../db/pool';

export interface AuditEventInput {
  entityType: 'settlement' | 'ledger_order' | 'match_candidate' | 'resolution';
  entityId: number;
  stage: string; // e.g. 'stage1_exact', 'decision_gate', 'ai_investigation'
  actorType: 'SYSTEM' | 'AI' | 'HUMAN' | 'DECISION_GATE';
  evidenceUsed: object | null;
  aiRawOutput: object | null; // never merged with decisionGateOutput
  decisionGateOutput: object | null; // never merged with aiRawOutput
}

async function insertWithConnection(event: AuditEventInput, connection: PoolConnection): Promise<void> {
  // Look up the next sequence_no for this entity within the SAME
  // transaction as the insert below, to avoid a race producing duplicate
  // sequence numbers. FOR UPDATE locks any existing matching rows - which
  // protects every event after an entity's first. The very first audit
  // event for a brand-new entityType+entityId pair has no row to lock yet,
  // so a true race on that specific first insert isn't fully closed by this
  // alone; closing that would need a dedicated counter/advisory-lock
  // mechanism, which is out of scope here (this is exactly what the prompt
  // asked for: MAX(sequence_no)+1 within the same transaction, not a
  // stronger guarantee).
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    'SELECT COALESCE(MAX(sequence_no), 0) + 1 AS nextSeq FROM audit_events WHERE entity_type = ? AND entity_id = ? FOR UPDATE',
    [event.entityType, event.entityId],
  );
  const nextSeq = rows[0].nextSeq as number;

  await connection.query(
    `INSERT INTO audit_events
      (entity_type, entity_id, stage, actor_type, evidence_used, ai_raw_output, decision_gate_output, sequence_no)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.entityType,
      event.entityId,
      event.stage,
      event.actorType,
      event.evidenceUsed !== null ? JSON.stringify(event.evidenceUsed) : null,
      event.aiRawOutput !== null ? JSON.stringify(event.aiRawOutput) : null,
      event.decisionGateOutput !== null ? JSON.stringify(event.decisionGateOutput) : null,
      nextSeq,
    ],
  );
}

/**
 * Inserts one audit event. If `connection` is provided, this participates
 * in the CALLER's existing transaction (does not begin/commit/rollback/
 * release it) - this is what lets decisionGate.ts make a resolutions write
 * and its audit event atomic together. If omitted, this manages its own
 * short transaction so the sequence-number lookup and the insert are still
 * atomic with each other, even for a standalone call (e.g. from
 * reviewQueue.ts, which has no broader transaction to join).
 */
export async function insertAuditEvent(event: AuditEventInput, connection?: PoolConnection): Promise<void> {
  if (connection) {
    await insertWithConnection(event, connection);
    return;
  }

  const pool = getPool();
  const ownConnection = await pool.getConnection();
  try {
    await ownConnection.beginTransaction();
    await insertWithConnection(event, ownConnection);
    await ownConnection.commit();
  } catch (err) {
    await ownConnection.rollback();
    throw err;
  } finally {
    ownConnection.release();
  }
}
