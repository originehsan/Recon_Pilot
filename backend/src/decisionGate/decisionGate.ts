// The core safety chokepoint: the ONLY module in the codebase that writes
// to `resolutions`, and the ONLY module allowed to call
// brandResolvedDecision (types.ts). Every settlement finalization, from
// every stage, funnels through finalizeCase.

import mysql, { PoolConnection } from 'mysql2/promise';
import crypto from 'crypto';
import { getPool } from '../db/pool';
import { insertAuditEvent } from '../audit/auditRepository';
import { brandResolvedDecision, ResolvedDecision } from './types';

export interface FinalizeInput {
  settlementIds: number[]; // usually 1, but >1 for split-payment composite finalization
  ledgerOrderId: number | null;
  finalStatus: 'matched' | 'rejected' | 'unresolved';
  decidedBy: 'stage1_exact' | 'stage7_auto' | 'post_ai' | 'human';
  matchCandidateId: number | null;
  aiInvestigationId: number | null;
  evidenceVersion: number;
  evidence: object; // whatever was used to decide - will be hashed and logged
  reasonCode: string;
}

interface ResolutionRow {
  id: number;
  settlement_id: number;
  ledger_order_id: number | null;
  match_candidate_id: number | null;
  ai_investigation_id: number | null;
  final_status: 'matched' | 'rejected' | 'unresolved';
  decided_by: FinalizeInput['decidedBy'];
  evidence_version: number;
  evidence_hash: string;
  supersedes_resolution_id: number | null;
}

interface SettlementOutcome {
  settlementId: number;
  resolutionId: number;
  ledgerOrderId: number | null;
  finalStatus: FinalizeInput['finalStatus'];
  decidedBy: FinalizeInput['decidedBy'];
  matchCandidateId: number | null;
  aiInvestigationId: number | null;
  evidenceVersion: number;
  evidenceHash: string;
  wasNoOp: boolean;
}

/**
 * Canonical JSON stringification (sorted object keys at every level) so two
 * evidence objects that are semantically identical but built with keys in a
 * different order always hash to the same value.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * The "head" resolution for a settlement: the one no OTHER resolution's
 * supersedes_resolution_id points to. At most one should exist at any time
 * for a healthy correction chain - ORDER BY id DESC LIMIT 1 is a defensive
 * tiebreak, not something expected to matter in practice.
 */
async function getCurrentResolution(settlementId: number, connection: PoolConnection): Promise<ResolutionRow | null> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT r.* FROM resolutions r
     WHERE r.settlement_id = ?
       AND NOT EXISTS (SELECT 1 FROM resolutions r2 WHERE r2.supersedes_resolution_id = r.id)
     ORDER BY r.id DESC
     LIMIT 1`,
    [settlementId],
  );
  return rows.length > 0 ? (rows[0] as ResolutionRow) : null;
}

async function insertResolutionRow(
  connection: PoolConnection,
  params: {
    settlementId: number;
    ledgerOrderId: number | null;
    matchCandidateId: number | null;
    aiInvestigationId: number | null;
    finalStatus: FinalizeInput['finalStatus'];
    decidedBy: FinalizeInput['decidedBy'];
    evidenceVersion: number;
    evidenceHash: string;
    supersedesResolutionId: number | null;
  },
): Promise<number> {
  // NOTE: resolutions has no reason_code column (see migration 001) - the
  // reason lives only in the paired audit_events row's decision_gate_output,
  // never on the resolution itself.
  const [result] = await connection.query<mysql.ResultSetHeader>(
    `INSERT INTO resolutions
      (settlement_id, ledger_order_id, match_candidate_id, ai_investigation_id, final_status, decided_by, evidence_version, evidence_hash, supersedes_resolution_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.settlementId,
      params.ledgerOrderId,
      params.matchCandidateId,
      params.aiInvestigationId,
      params.finalStatus,
      params.decidedBy,
      params.evidenceVersion,
      params.evidenceHash,
      params.supersedesResolutionId,
    ],
  );
  return result.insertId;
}

export async function finalizeCase(input: FinalizeInput): Promise<ResolvedDecision> {
  if (input.settlementIds.length === 0) {
    throw new Error('finalizeCase: settlementIds must not be empty.');
  }

  const evidenceHash = sha256Hex(canonicalStringify(input.evidence));
  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Step 1: acquire a row lock per settlement, serializing concurrent
    // finalize attempts for the same settlement(s). Locked in a fixed
    // (ascending id) order regardless of the input array's order, so two
    // overlapping composite groups finalized concurrently can never
    // deadlock waiting on each other in opposite lock orders.
    const settlementIdsForLocking = [...input.settlementIds].sort((a, b) => a - b);
    for (const settlementId of settlementIdsForLocking) {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT id FROM ingested_settlements WHERE id = ? FOR UPDATE',
        [settlementId],
      );
      if (rows.length === 0) {
        throw new Error(`finalizeCase: settlement id ${settlementId} does not exist.`);
      }
    }

    // Fetch the AI investigation row (if any) to attach to the audit event -
    // kept in its own field, never merged into decisionGateOutput.
    let aiRawOutputForAudit: object | null = null;
    if (input.aiInvestigationId !== null) {
      const [aiRows] = await connection.query<mysql.RowDataPacket[]>('SELECT * FROM ai_investigations WHERE id = ?', [
        input.aiInvestigationId,
      ]);
      aiRawOutputForAudit = aiRows.length > 0 ? (aiRows[0] as object) : null;
    }

    const outcomes: SettlementOutcome[] = [];

    for (const settlementId of input.settlementIds) {
      const current = await getCurrentResolution(settlementId, connection);

      if (current && current.final_status === input.finalStatus && current.ledger_order_id === input.ledgerOrderId) {
        // Idempotent re-finalization: identical outcome already recorded -
        // return the existing decision unchanged, do not insert a duplicate.
        outcomes.push({
          settlementId,
          resolutionId: current.id,
          ledgerOrderId: current.ledger_order_id,
          finalStatus: current.final_status,
          decidedBy: current.decided_by,
          matchCandidateId: current.match_candidate_id,
          aiInvestigationId: current.ai_investigation_id,
          evidenceVersion: current.evidence_version,
          evidenceHash: current.evidence_hash,
          wasNoOp: true,
        });
        continue;
      }

      // Either no prior resolution exists (fresh insert), or the outcome
      // genuinely differs (finalStatus and/or ledgerOrderId changed) - a
      // legitimate correction, recorded as a new row that supersedes the
      // prior one. Never silently overwrite.
      const supersedesResolutionId = current ? current.id : null;
      const newResolutionId = await insertResolutionRow(connection, {
        settlementId,
        ledgerOrderId: input.ledgerOrderId,
        matchCandidateId: input.matchCandidateId,
        aiInvestigationId: input.aiInvestigationId,
        finalStatus: input.finalStatus,
        decidedBy: input.decidedBy,
        evidenceVersion: input.evidenceVersion,
        evidenceHash,
        supersedesResolutionId,
      });

      outcomes.push({
        settlementId,
        resolutionId: newResolutionId,
        ledgerOrderId: input.ledgerOrderId,
        finalStatus: input.finalStatus,
        decidedBy: input.decidedBy,
        matchCandidateId: input.matchCandidateId,
        aiInvestigationId: input.aiInvestigationId,
        evidenceVersion: input.evidenceVersion,
        evidenceHash,
        wasNoOp: false,
      });
    }

    // The returned ResolvedDecision represents settlementIds[0] - for a
    // multi-settlement composite case every settlement gets an equivalent
    // resolutions row in this same transaction, but the function's return
    // type is a single decision (per the given signature).
    const primary = outcomes[0];

    const decision = brandResolvedDecision({
      settlementId: primary.settlementId,
      ledgerOrderId: primary.ledgerOrderId,
      finalStatus: primary.finalStatus,
      decidedBy: primary.decidedBy,
      matchCandidateId: primary.matchCandidateId,
      aiInvestigationId: primary.aiInvestigationId,
      evidenceVersion: primary.evidenceVersion,
      evidenceHash: primary.evidenceHash,
      reasonCode: input.reasonCode,
    });

    // REVISED (was: always logged, even on a pure no-op - see git history /
    // prior comment here for the original reasoning). That produced
    // unbounded audit-log growth in practice: every re-run's re-scan of an
    // already-resolved settlement (see matching/dbLoader.ts's
    // excludeResolved option, added alongside this fix, for the real root
    // cause of WHY re-scans happen at all) re-triggered finalizeCase for the
    // same settlement, and every one of those no-op calls wrote a full
    // audit_events row - confirmed live: resolution id 1 alone had 13 rows,
    // 12 of them `allNoOp: true` from 12 separate re-runs of an unchanged
    // decision. A pure re-confirmation with zero actual change is not a new
    // decision - only write the audit event when at least one settlement in
    // this call had a genuine outcome (freshly created or superseded).
    const allNoOp = outcomes.every((o) => o.wasNoOp);

    if (!allNoOp) {
      await insertAuditEvent(
        {
          entityType: 'resolution',
          entityId: primary.resolutionId,
          stage: 'decision_gate',
          actorType: 'DECISION_GATE',
          evidenceUsed: input.evidence,
          aiRawOutput: aiRawOutputForAudit,
          decisionGateOutput: {
            settlementIds: input.settlementIds,
            resolutionIds: outcomes.map((o) => o.resolutionId),
            ledgerOrderId: input.ledgerOrderId,
            finalStatus: input.finalStatus,
            decidedBy: input.decidedBy,
            reasonCode: input.reasonCode,
            evidenceHash,
            allNoOp,
          },
        },
        connection,
      );
    }

    await connection.commit();
    return decision;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

/**
 * Read-only lookup of a settlement's current (head-of-chain) resolution id,
 * or null if it has none. Not a write, not a ResolvedDecision, and not
 * covered by the "only decisionGate.ts writes resolutions" invariant - that
 * invariant is about constructing/branding a finalized decision and about
 * INSERT/UPDATE/DELETE against `resolutions`, not about reading it.
 *
 * Added for backend/src/api/routes/exceptions.ts: finalizeCase's returned
 * ResolvedDecision does not include the new resolutions row's id (see
 * ResolvedDecisionProps in types.ts - it was never part of that shape), but
 * POST /api/exceptions/:id/resolve needs it to record review_queue.resolution_id
 * after a human resolves an exception. Exported here (reusing the exact
 * same head-of-chain query getCurrentResolution already uses internally)
 * rather than duplicating that SQL pattern in the API layer.
 */
export async function getCurrentResolutionId(settlementId: number): Promise<number | null> {
  const pool = getPool();
  const connection = await pool.getConnection();
  try {
    const current = await getCurrentResolution(settlementId, connection);
    return current ? current.id : null;
  } finally {
    connection.release();
  }
}
