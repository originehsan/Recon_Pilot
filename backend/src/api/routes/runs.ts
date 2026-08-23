// Step 3 & 4: POST /api/runs (kicks off the full pipeline asynchronously)
// and GET /api/runs/:id (polls its status). This is the one route that
// makes REAL Gemini calls (via investigate, not a mock) - see this prompt's
// summary for the quota warning.

import { Router, Request, Response, NextFunction } from 'express';
import mysql from 'mysql2/promise';
import { getPool } from '../../db/pool';
import { CreateRunSchema } from '../schemas';
import { loadSettlementsAndOrders } from '../../matching/dbLoader';
import { loadGroundTruth } from '../../matching/groundTruth';
import { runFullPipeline } from '../../matching/runFullPipeline';
import { orchestrateBatch, ProgressCounts, InvestigateFn } from '../../decisionGate/orchestrate';
import { investigate } from '../../aiInvestigation/investigate';

const router = Router();

// Same free-tier pacing established live in aiInvestigation/manualVerify.ts
// and decisionGate/verifyDecisionGate.ts (5 requests/minute for
// gemini-3.6-flash - see llmClient.ts). A live run can contain more than one
// ai_investigation case; without pacing, back-to-back real calls would risk
// 429s well before the batch finishes. Not extracted into a shared helper
// alongside verifyDecisionGate.ts's own copy - see this prompt's summary for
// why (trivial duplication, kept separate rather than touching an
// already-verified script).
const REAL_AI_PACING_MS = 13_000;

function createPacedInvestigateFn(): InvestigateFn {
  let callCount = 0;
  return async (bundle) => {
    if (callCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, REAL_AI_PACING_MS));
    }
    callCount++;
    return investigate(bundle);
  };
}

router.post('/runs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Validated for shape, but batchId is intentionally never read below -
    // see Step 0.1 and schemas.ts's comment on CreateRunSchema.
    CreateRunSchema.parse(req.body ?? {});

    const pool = getPool();
    const [existing] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT id FROM batch_runs WHERE status IN ('pending', 'processing') LIMIT 1`,
    );
    if (existing.length > 0) {
      res.status(409).json({ error: 'A run is already in progress', existingRunId: existing[0].id });
      return;
    }

    const [insertResult] = await pool.query<mysql.ResultSetHeader>(
      `INSERT INTO batch_runs (status, progress) VALUES ('pending', NULL)`,
    );
    const runId = insertResult.insertId;

    res.status(202).json({ runId, status: 'pending' });

    // Fire-and-forget: NOT awaited by the route handler (per spec). Errors
    // are caught inside and persisted onto the batch_runs row itself, never
    // thrown into an unhandled rejection here.
    void processRunAsync(runId);
  } catch (err) {
    next(err);
  }
});

async function updateProgress(runId: number, progress: ProgressCounts): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE batch_runs SET progress = ? WHERE id = ?', [JSON.stringify(progress), runId]);
}

async function processRunAsync(runId: number): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(`UPDATE batch_runs SET status = 'processing', started_at = NOW() WHERE id = ?`, [runId]);

    const { settlements, orders } = await loadSettlementsAndOrders();
    const groundTruth = loadGroundTruth();
    const { routedCases, thresholds } = runFullPipeline(settlements, orders, groundTruth);

    const investigateFn = createPacedInvestigateFn();
    await orchestrateBatch(routedCases, investigateFn, thresholds, (progress) => updateProgress(runId, progress));

    await pool.query(`UPDATE batch_runs SET status = 'completed', completed_at = NOW() WHERE id = ?`, [runId]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Run ${runId} failed:`, message);
    try {
      await pool.query(`UPDATE batch_runs SET status = 'failed', error_message = ?, completed_at = NOW() WHERE id = ?`, [
        message,
        runId,
      ]);
    } catch (updateErr) {
      // Even recording the failure failed - don't let that throw into an
      // unhandled rejection either. Surface it on stderr as a last resort.
      console.error(`Run ${runId}: failed to record failure status:`, updateErr);
    }
  }
}

router.get('/runs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    const pool = getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT * FROM batch_runs WHERE id = ?', [id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    const row = rows[0];
    res.json({
      runId: row.id,
      status: row.status,
      progress: row.progress, // JSON column - mysql2 auto-parses it back into an object
      startedAt: row.started_at,
      completedAt: row.completed_at,
    });
  } catch (err) {
    next(err);
  }
});

// Step 5: GET /api/runs/:id/exceptions.
//
// review_queue has no run/batch linkage anywhere in its schema (see
// 003_add_review_queue.sql), and Step 0.1 explicitly forbids retrofitting
// batch-scoped filtering into the matching/decision-gate layers that
// populate it. So this cannot literally return "this run's exceptions" -
// there is no such scoped set to query. Resolved pragmatically, consistent
// with Step 0's own model (the pipeline always operates over the full
// current unresolved set, not a per-run slice): validate that the run id
// exists (404 otherwise, matching GET /api/runs/:id's semantics), then
// return the current GLOBAL review queue. Disclosed here rather than
// silently narrowing or inventing a run_id column.
router.get('/runs/:id/exceptions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    const pool = getPool();
    const [runRows] = await pool.query<mysql.RowDataPacket[]>('SELECT id FROM batch_runs WHERE id = ?', [id]);
    if (runRows.length === 0) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';

    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT
         rq.id AS reviewId,
         rq.reason_code AS reasonCode,
         rq.exposure_amount AS exposureAmount,
         rq.priority_score AS priorityScore,
         rq.status AS status,
         rq.created_at AS createdAt,
         s.entity_id AS settlementEntityId,
         s.amount AS settlementAmount,
         s.narration AS narration
       FROM review_queue rq
       JOIN match_candidates mc ON mc.id = rq.match_candidate_id
       JOIN ingested_settlements s ON s.id = mc.settlement_id
       WHERE rq.status = ?
       ORDER BY rq.priority_score DESC`,
      [status],
    );

    // mysql2 returns DECIMAL columns (exposure_amount, priority_score,
    // ingested_settlements.amount) as JS STRINGS by default, not numbers -
    // confirmed live (e.g. priority_score came back as "40443737.60000000",
    // typeof "string"). The Exception TS type below has always declared
    // these as `number`, so every consumer (Dashboard.tsx, Exceptions.tsx)
    // reasonably called number methods like .toFixed() directly on them -
    // which crashed the moment a real run actually populated review_queue,
    // since dev/test data until now never exercised this path with a live
    // DB round trip. Converted to real numbers here, at the API boundary,
    // so the response honestly matches its own declared type instead of
    // leaking a MySQL driver implementation detail to every caller.
    res.json(
      rows.map((row) => ({
        reviewId: row.reviewId,
        reasonCode: row.reasonCode,
        exposureAmount: Number(row.exposureAmount),
        priorityScore: Number(row.priorityScore),
        status: row.status,
        settlementEntityId: row.settlementEntityId,
        settlementAmount: Number(row.settlementAmount),
        narration: row.narration,
        createdAt: row.createdAt,
      })),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
