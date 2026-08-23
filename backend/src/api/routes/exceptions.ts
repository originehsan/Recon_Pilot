// Step 6: POST /api/exceptions/:id/resolve. The ONLY way this route ever
// creates a finalized decision is by calling the existing finalizeCase from
// decisionGate.ts - no new resolutions-table write logic here, which would
// violate the core invariant established in the decisionGate/audit prompt.

import { Router, Request, Response, NextFunction } from 'express';
import mysql from 'mysql2/promise';
import { getPool } from '../../db/pool';
import { ResolveExceptionSchema } from '../schemas';
import { finalizeCase, getCurrentResolutionId } from '../../decisionGate/decisionGate';
import { EVIDENCE_VERSION } from '../../decisionGate/routingPolicy';

const router = Router();

interface ReviewQueueRow extends mysql.RowDataPacket {
  id: number;
  match_candidate_id: number | null;
  status: string;
  settlement_id: number;
}

// review_queue.status is ENUM('pending','resolved','dismissed') (see
// 003_add_review_queue.sql) - there is no 'closed' value, which is what the
// prompt's own spec names. Substituted with the closest existing
// equivalent, 'resolved', for all three actions uniformly (approve_match,
// reject, and mark_unresolved all end with a resolution_id now attached to
// this row, which is literally true regardless of which action was taken) -
// disclosed here rather than silently inventing a new enum value or
// picking 'dismissed' for only some actions on no clearer justification.
const REVIEW_QUEUE_TERMINAL_STATUS = 'resolved';

router.post('/exceptions/:id/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const body = ResolveExceptionSchema.parse(req.body);

    const pool = getPool();
    const [rows] = await pool.query<ReviewQueueRow[]>(
      `SELECT rq.id, rq.match_candidate_id, rq.status, mc.settlement_id
       FROM review_queue rq
       JOIN match_candidates mc ON mc.id = rq.match_candidate_id
       WHERE rq.id = ?`,
      [id],
    );

    if (rows.length === 0 || rows[0].status !== 'pending') {
      res.status(404).json({ error: 'Exception not found or already resolved' });
      return;
    }

    const row = rows[0];

    const finalizeParams = (() => {
      switch (body.action) {
        case 'approve_match':
          return {
            ledgerOrderId: body.ledgerOrderId,
            finalStatus: 'matched' as const,
            reasonCode: 'human_approved_match',
          };
        case 'reject':
          return { ledgerOrderId: null, finalStatus: 'rejected' as const, reasonCode: 'human_rejected' };
        case 'mark_unresolved':
          return { ledgerOrderId: null, finalStatus: 'unresolved' as const, reasonCode: 'human_marked_unresolved' };
      }
    })();

    const decision = await finalizeCase({
      settlementIds: [row.settlement_id],
      ledgerOrderId: finalizeParams.ledgerOrderId,
      finalStatus: finalizeParams.finalStatus,
      decidedBy: 'human',
      matchCandidateId: row.match_candidate_id,
      aiInvestigationId: null,
      evidenceVersion: EVIDENCE_VERSION,
      evidence: {
        caseType: 'human_review_exception',
        reviewQueueId: id,
        action: body.action,
        ledgerOrderId: finalizeParams.ledgerOrderId,
        notes: body.notes ?? null,
      },
      reasonCode: finalizeParams.reasonCode,
    });

    const resolutionId = await getCurrentResolutionId(row.settlement_id);

    await pool.query('UPDATE review_queue SET status = ?, resolution_id = ? WHERE id = ?', [
      REVIEW_QUEUE_TERMINAL_STATUS,
      resolutionId,
      id,
    ]);

    res.json({ decision });
  } catch (err) {
    next(err);
  }
});

export default router;
