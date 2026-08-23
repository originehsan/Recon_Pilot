// Step 2: POST /api/batches. Batch upload for demo/manual-verification
// purposes - inserts settlements/orders tagged with a fresh batch_id for
// record-keeping only (see Step 0.1: batch_id is never used to scope what
// the matching pipeline or decision gate later process).

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import mysql from 'mysql2/promise';
import { getPool } from '../../db/pool';
import { BatchUploadSchema, BatchUploadInput } from '../schemas';

const router = Router();

type SettlementInput = BatchUploadInput['settlements'][number];
type OrderInput = BatchUploadInput['orders'][number];

const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === ER_DUP_ENTRY;
}

/**
 * Mirrors seed.ts's content_hash pattern (sha256 of the record's own
 * content) but is NOT extracted into a shared function with seed.ts: the
 * two build genuinely different raw_payload shapes (seed.ts invents
 * settlement_id/settlement_utr/payment_id/created_at for synthetic data;
 * this uses exactly what the caller submitted, nothing invented, no
 * timestamp - a wall-clock field would make two literally-identical rows
 * within the SAME upload hash differently, defeating the very duplicate
 * check this hash exists for). The duplication that remains (one sha256
 * call) is trivial, per the prompt's own "otherwise keep them separate if
 * the duplication is trivial" guidance.
 */
function computeSettlementContentHash(s: SettlementInput): string {
  const payload = {
    entityId: s.entityId,
    type: s.type,
    settlementId: s.settlementId,
    settlementUtr: s.settlementUtr,
    orderId: s.orderId,
    paymentId: s.paymentId,
    amount: s.amount,
    fee: s.fee,
    tax: s.tax,
    onHold: s.onHold,
    disputeId: s.disputeId,
    creditType: s.creditType,
    narration: s.narration,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

interface SkippedRecord {
  index: number;
  reason: string;
}

router.post('/batches', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = BatchUploadSchema.parse(req.body);
    const pool = getPool();

    const [maxRows] = await pool.query<mysql.RowDataPacket[]>('SELECT MAX(batch_id) AS maxBatchId FROM ingested_settlements');
    const batchId = ((maxRows[0].maxBatchId as number | null) ?? 0) + 1;

    const skippedSettlements: SkippedRecord[] = [];
    const skippedOrders: SkippedRecord[] = [];
    const seenContentHashes = new Set<string>();
    const seenOrderIds = new Set<string>();

    let settlementsInserted = 0;
    for (let i = 0; i < body.settlements.length; i++) {
      const s = body.settlements[i];
      const contentHash = computeSettlementContentHash(s);

      // Guard against a duplicate content_hash within this same batch (the
      // prompt's explicit requirement) - "should not normally happen", so
      // this is defensive, not the expected path.
      if (seenContentHashes.has(contentHash)) {
        skippedSettlements.push({ index: i, reason: 'duplicate_content_hash_in_batch' });
        continue;
      }
      seenContentHashes.add(contentHash);

      const rawPayload = { ...s, contentHash };
      try {
        await pool.query(
          `INSERT INTO ingested_settlements
            (batch_id, entity_id, type, settlement_id, settlement_utr, order_id, payment_id,
             amount, fee, tax, on_hold, dispute_id, credit_type, narration, raw_payload, content_hash, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            batchId,
            s.entityId,
            s.type,
            s.settlementId,
            s.settlementUtr,
            s.orderId,
            s.paymentId,
            s.amount,
            s.fee,
            s.tax,
            s.onHold,
            s.disputeId,
            s.creditType,
            s.narration,
            JSON.stringify(rawPayload),
            contentHash,
            crypto.randomUUID(),
          ],
        );
        settlementsInserted++;
      } catch (err) {
        // settlement_utr has its own UNIQUE KEY (see 001_initial_schema.sql)
        // independent of content_hash - a real collision against a
        // PRE-EXISTING row from an earlier batch. Extended the same
        // "skip and note, don't fail the whole batch" treatment to this
        // case too, not just the literal content_hash guard the prompt
        // asked for - disclosed in this prompt's summary.
        if (isDuplicateKeyError(err)) {
          skippedSettlements.push({ index: i, reason: 'db_duplicate_key' });
          continue;
        }
        throw err;
      }
    }

    let ordersInserted = 0;
    for (let i = 0; i < body.orders.length; i++) {
      const o: OrderInput = body.orders[i];

      if (seenOrderIds.has(o.orderId)) {
        skippedOrders.push({ index: i, reason: 'duplicate_order_id_in_batch' });
        continue;
      }
      seenOrderIds.add(o.orderId);

      const rawPayload = { ...o };
      try {
        await pool.query(
          `INSERT INTO ledger_orders (batch_id, order_id, expected_amount, expected_reference, expected_date, raw_payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [batchId, o.orderId, o.expectedAmount, o.expectedReference, o.expectedDate, JSON.stringify(rawPayload)],
        );
        ordersInserted++;
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          skippedOrders.push({ index: i, reason: 'db_duplicate_key' });
          continue;
        }
        throw err;
      }
    }

    res.status(201).json({
      batchId,
      settlementsInserted,
      ordersInserted,
      ...(skippedSettlements.length > 0 ? { skippedSettlements } : {}),
      ...(skippedOrders.length > 0 ? { skippedOrders } : {}),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
