// Step 5: routes a case the gate cannot safely auto-finalize into
// review_queue instead. Every write here is paired with an audit event in
// the SAME transaction - "every decision, terminal or not, gets logged"
// applies to review-routing exactly as much as to finalizeCase.

import mysql from 'mysql2/promise';
import { getPool } from '../db/pool';
import { insertAuditEvent } from '../audit/auditRepository';

export interface EnqueueForReviewInput {
  matchCandidateId: number | null;
  reasonCode: string;
  exposureAmount: number;
  priorityScore: number;
}

export async function enqueueForReview(input: EnqueueForReviewInput): Promise<void> {
  if (input.matchCandidateId === null) {
    // In normal operation this should never happen: orchestrate.ts always
    // populates match_candidates for every settlement before routing a
    // case, so there is always a real id to reference. Treated as a loud,
    // defensive failure rather than silently recording an audit event with
    // a fabricated entityId (audit_events.entity_id is a real, non-nullable
    // numeric column).
    throw new Error('enqueueForReview: matchCandidateId must not be null.');
  }

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [result] = await connection.query<mysql.ResultSetHeader>(
      `INSERT INTO review_queue (match_candidate_id, reason_code, exposure_amount, priority_score, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [input.matchCandidateId, input.reasonCode, input.exposureAmount, input.priorityScore],
    );

    await insertAuditEvent(
      {
        entityType: 'match_candidate',
        entityId: input.matchCandidateId,
        stage: 'decision_gate',
        actorType: 'DECISION_GATE',
        evidenceUsed: null,
        aiRawOutput: null,
        decisionGateOutput: {
          reviewQueueId: result.insertId,
          reasonCode: input.reasonCode,
          exposureAmount: input.exposureAmount,
          priorityScore: input.priorityScore,
          status: 'pending',
        },
      },
      connection,
    );

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}
