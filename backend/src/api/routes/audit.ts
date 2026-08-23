// Step 7: GET /api/audit?entityType=...&entityId=... - read-only, ordered
// by sequence_no. evidenceUsed, aiRawOutput, and decisionGateOutput are
// returned as separate fields, never merged, per audit/auditRepository.ts's
// own design.

import { Router, Request, Response, NextFunction } from 'express';
import mysql from 'mysql2/promise';
import { getPool } from '../../db/pool';

const router = Router();

router.get('/audit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : undefined;
    const entityIdRaw = typeof req.query.entityId === 'string' ? req.query.entityId : undefined;

    if (!entityType || !entityIdRaw) {
      res.status(400).json({ error: 'entityType and entityId query parameters are both required' });
      return;
    }

    const entityId = Number(entityIdRaw);
    if (!Number.isInteger(entityId)) {
      res.status(400).json({ error: 'entityId must be an integer' });
      return;
    }

    const pool = getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT id, entity_type, entity_id, stage, actor_type, evidence_used, ai_raw_output, decision_gate_output, sequence_no, created_at
       FROM audit_events
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY sequence_no ASC`,
      [entityType, entityId],
    );

    res.json(
      rows.map((row) => ({
        id: row.id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        stage: row.stage,
        actorType: row.actor_type,
        evidenceUsed: row.evidence_used,
        aiRawOutput: row.ai_raw_output,
        decisionGateOutput: row.decision_gate_output,
        sequenceNo: row.sequence_no,
        createdAt: row.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
