// Standalone synthetic data generator.
//
//   npm run seed
//
// Populates ledger_orders and ingested_settlements with synthetic test data
// covering every reconciliation edge case the later pipeline stages need to
// handle, and writes a ground-truth log to backend/src/db/ground-truth.json
// (NOT into the database) so later stages can be evaluated against it.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BATCH_ID = 1;
const GROUND_TRUTH_PATH = path.join(__dirname, 'ground-truth.json');

type Category =
  | 'CLEAN_EXACT'
  | 'CORRUPTED_TRUNCATED'
  | 'CORRUPTED_SUBSTITUTED'
  | 'SPLIT_PAYMENT'
  | 'AMBIGUOUS_DUPLICATE'
  | 'UNMATCHED'
  | 'ON_HOLD';

const TARGET_COUNTS: Record<Category, number> = {
  CLEAN_EXACT: 126,
  CORRUPTED_TRUNCATED: 14,
  CORRUPTED_SUBSTITUTED: 13,
  SPLIT_PAYMENT: 9,
  AMBIGUOUS_DUPLICATE: 9,
  UNMATCHED: 6,
  ON_HOLD: 3,
};

const TOTAL_ORDERS = Object.values(TARGET_COUNTS).reduce((a, b) => a + b, 0); // 180

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

const UPPER_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomChars(charset: string, length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset[Math.floor(Math.random() * charset.length)];
  }
  return result;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle<T>(arr: T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function randomOrderId(): string {
  return 'order_' + randomChars(UPPER_ALNUM, 12);
}

function randomId(prefix: string, length = 14): string {
  return prefix + randomChars(BASE62, length);
}

function randomUtr(): string {
  return 'UTR' + randomChars(UPPER_ALNUM, 16);
}

function randomAmountPaise(min = 50000, max = 500000): number {
  return randomInt(min, max);
}

function randomDateWithinLastDays(days: number): Date {
  const now = Date.now();
  const past = now - Math.random() * days * 24 * 60 * 60 * 1000;
  return new Date(past);
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 2% MDR fee, 18% GST on that fee, net amount = expected - fee - tax. */
function computeFeeBreakdown(amount: number) {
  const fee = round2(amount * 0.02);
  const tax = round2(fee * 0.18);
  const netAmount = round2(amount - fee - tax);
  return { fee, tax, netAmount };
}

function truncateOrderId(orderId: string): string {
  const cut = randomInt(2, 4);
  return orderId.slice(0, -cut);
}

function substituteOrderId(orderId: string): string {
  const prefixLen = 'order_'.length;
  const chars = orderId.split('');
  const suffixIndices = chars.map((_, i) => i).slice(prefixLen);
  const numSubs = Math.min(randomInt(1, 2), suffixIndices.length);

  const chosen = new Set<number>();
  while (chosen.size < numSubs) {
    chosen.add(suffixIndices[Math.floor(Math.random() * suffixIndices.length)]);
  }

  for (const idx of chosen) {
    let newChar: string;
    do {
      newChar = UPPER_ALNUM[Math.floor(Math.random() * UPPER_ALNUM.length)];
    } while (newChar === chars[idx]);
    chars[idx] = newChar;
  }

  return chars.join('');
}

/** Splits `net` into `parts` amounts that sum exactly to `net` (rounded to paise). */
function splitAmount(net: number, parts: number): number[] {
  const amounts: number[] = [];
  let remaining = net;
  for (let i = 0; i < parts - 1; i++) {
    const minShare = remaining * 0.2;
    const maxShare = remaining * 0.6;
    const share = round2(minShare + Math.random() * (maxShare - minShare));
    amounts.push(share);
    remaining = round2(remaining - share);
  }
  amounts.push(remaining);
  return amounts;
}

/**
 * Allocates `total` across `weights.length` buckets, proportionally to each
 * weight, so the allocations sum EXACTLY to `total` (rounded to paise).
 *
 * Used to split a split-payment order's single order-level fee/tax across
 * its settlement legs in proportion to each leg's amount - rather than
 * recomputing 2%/18% independently on each leg's own (already-net) partial
 * amount, which would not sum back to the order's real fee/tax and would
 * break the amount <-> fee/tax reconciliation the matching pipeline's
 * split-payment detector (Stage 3) depends on.
 */
function allocateProportionally(total: number, weights: number[]): number[] {
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  const allocations: number[] = [];
  let remaining = total;
  for (let i = 0; i < weights.length - 1; i++) {
    const share = weightSum === 0 ? 0 : round2((weights[i] / weightSum) * total);
    allocations.push(share);
    remaining = round2(remaining - share);
  }
  allocations.push(remaining);
  return allocations;
}

// ---------------------------------------------------------------------------
// Settlement record builder
// ---------------------------------------------------------------------------

interface SettlementRecord {
  batch_id: number;
  entity_id: string;
  type: string;
  settlement_id: string;
  settlement_utr: string;
  order_id: string;
  payment_id: string;
  amount: number;
  fee: number;
  tax: number;
  on_hold: boolean;
  dispute_id: string | null;
  credit_type: string;
  raw_payload: Record<string, unknown>;
  content_hash: string;
  idempotency_key: string;
}

function buildSettlement(params: {
  orderId: string;
  amount: number;
  fee: number;
  tax: number;
  onHold?: boolean;
  disputeId?: string | null;
}): SettlementRecord {
  const paymentId = randomId('pay_');
  const entityId = paymentId; // mirrors the underlying payment entity id, as in real Razorpay recon rows
  const settlementId = randomId('setl_');
  const settlementUtr = randomUtr();
  const onHold = params.onHold ?? false;
  const disputeId = params.disputeId ?? null;

  const rawPayload = {
    entity_id: entityId,
    type: 'settlement',
    amount: params.amount,
    fee: params.fee,
    tax: params.tax,
    currency: 'INR',
    settlement_id: settlementId,
    settlement_utr: settlementUtr,
    order_id: params.orderId,
    payment_id: paymentId,
    on_hold: onHold,
    dispute_id: disputeId,
    credit_type: 'default',
    created_at: Math.floor(Date.now() / 1000),
  };

  const contentHash = crypto.createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex');

  return {
    batch_id: BATCH_ID,
    entity_id: entityId,
    type: 'settlement',
    settlement_id: settlementId,
    settlement_utr: settlementUtr,
    order_id: params.orderId,
    payment_id: paymentId,
    amount: params.amount,
    fee: params.fee,
    tax: params.tax,
    on_hold: onHold,
    dispute_id: disputeId,
    credit_type: 'default',
    raw_payload: rawPayload,
    content_hash: contentHash,
    idempotency_key: crypto.randomUUID(),
  };
}

async function insertSettlement(pool: mysql.Pool, s: SettlementRecord): Promise<void> {
  await pool.query(
    `INSERT INTO ingested_settlements
      (batch_id, entity_id, type, settlement_id, settlement_utr, order_id, payment_id,
       amount, fee, tax, on_hold, dispute_id, credit_type, raw_payload, content_hash, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.batch_id,
      s.entity_id,
      s.type,
      s.settlement_id,
      s.settlement_utr,
      s.order_id,
      s.payment_id,
      s.amount,
      s.fee,
      s.tax,
      s.on_hold,
      s.dispute_id,
      s.credit_type,
      JSON.stringify(s.raw_payload),
      s.content_hash,
      s.idempotency_key,
    ],
  );
}

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

interface GroundTruthEntry {
  entity_id: string | null;
  order_id: string;
  category: Category;
}

// ---------------------------------------------------------------------------
// Task list construction
// ---------------------------------------------------------------------------

interface Task {
  category: Category;
  splitParts?: number; // only for SPLIT_PAYMENT
}

function buildTaskList(): Task[] {
  const tasks: Task[] = [];

  for (const category of Object.keys(TARGET_COUNTS) as Category[]) {
    if (category === 'SPLIT_PAYMENT') {
      // 2 of the 9 split-payment orders get 3 settlement records, the rest get 2.
      const threeWayCount = 2;
      const twoWayCount = TARGET_COUNTS.SPLIT_PAYMENT - threeWayCount;
      for (let i = 0; i < threeWayCount; i++) tasks.push({ category, splitParts: 3 });
      for (let i = 0; i < twoWayCount; i++) tasks.push({ category, splitParts: 2 });
    } else {
      for (let i = 0; i < TARGET_COUNTS[category]; i++) tasks.push({ category });
    }
  }

  return shuffle(tasks);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function seed(): Promise<void> {
  const pool = mysql.createPool({
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });

  // This script is meant to be re-runnable from a clean slate: clear out any
  // previously-seeded rows first so re-running it replaces the dataset
  // instead of silently duplicating it on top of what's already there.
  console.log('Clearing previously-seeded data from ingested_settlements and ledger_orders...');
  await pool.query('TRUNCATE TABLE ingested_settlements');
  await pool.query('TRUNCATE TABLE ledger_orders');

  const groundTruth: GroundTruthEntry[] = [];
  const counts: Record<Category, number> = {
    CLEAN_EXACT: 0,
    CORRUPTED_TRUNCATED: 0,
    CORRUPTED_SUBSTITUTED: 0,
    SPLIT_PAYMENT: 0,
    AMBIGUOUS_DUPLICATE: 0,
    UNMATCHED: 0,
    ON_HOLD: 0,
  };

  const tasks = buildTaskList();
  console.log(`Generating ${tasks.length} ledger orders with synthetic settlements...`);

  for (const task of tasks) {
    const orderId = randomOrderId();
    const expectedAmount = randomAmountPaise();
    const expectedDate = randomDateWithinLastDays(30);
    const { fee, tax, netAmount } = computeFeeBreakdown(expectedAmount);

    const ledgerRawPayload = {
      order_id: orderId,
      expected_amount: expectedAmount,
      expected_date: formatDate(expectedDate),
      currency: 'INR',
    };

    const [ledgerResult] = await pool.query<mysql.ResultSetHeader>(
      `INSERT INTO ledger_orders (batch_id, order_id, expected_amount, expected_reference, expected_date, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [BATCH_ID, orderId, expectedAmount, null, formatDate(expectedDate), JSON.stringify(ledgerRawPayload)],
    );
    void ledgerResult.insertId; // not needed downstream; ledger_orders.order_id is the join key

    switch (task.category) {
      case 'CLEAN_EXACT': {
        const settlement = buildSettlement({ orderId, amount: netAmount, fee, tax });
        await insertSettlement(pool, settlement);
        groundTruth.push({ entity_id: settlement.entity_id, order_id: orderId, category: task.category });
        counts.CLEAN_EXACT++;
        break;
      }

      case 'CORRUPTED_TRUNCATED': {
        const corruptedOrderId = truncateOrderId(orderId);
        const settlement = buildSettlement({ orderId: corruptedOrderId, amount: netAmount, fee, tax });
        await insertSettlement(pool, settlement);
        // Ground truth records the correct order_id so evaluation can check recovery.
        groundTruth.push({ entity_id: settlement.entity_id, order_id: orderId, category: task.category });
        counts.CORRUPTED_TRUNCATED++;
        break;
      }

      case 'CORRUPTED_SUBSTITUTED': {
        const corruptedOrderId = substituteOrderId(orderId);
        const settlement = buildSettlement({ orderId: corruptedOrderId, amount: netAmount, fee, tax });
        await insertSettlement(pool, settlement);
        groundTruth.push({ entity_id: settlement.entity_id, order_id: orderId, category: task.category });
        counts.CORRUPTED_SUBSTITUTED++;
        break;
      }

      case 'SPLIT_PAYMENT': {
        // Split the net settlement amount (post-fee/tax) into `parts` legs that sum
        // exactly to netAmount, and allocate the ONE order-level fee/tax across those
        // same legs proportionally to each leg's amount - not recomputed per-leg from
        // scratch, which would not sum back to the order's real fee/tax. This keeps
        // sum(legAmount) + sum(legFee) + sum(legTax) === expectedAmount exactly, which
        // is what the split-payment detector's exact subset-sum check relies on.
        const parts = task.splitParts ?? 2;
        const amounts = splitAmount(netAmount, parts);
        const legFees = allocateProportionally(fee, amounts);
        const legTaxes = allocateProportionally(tax, amounts);
        for (let i = 0; i < amounts.length; i++) {
          const settlement = buildSettlement({ orderId, amount: amounts[i], fee: legFees[i], tax: legTaxes[i] });
          await insertSettlement(pool, settlement);
          groundTruth.push({ entity_id: settlement.entity_id, order_id: orderId, category: task.category });
        }
        counts.SPLIT_PAYMENT++;
        break;
      }

      case 'AMBIGUOUS_DUPLICATE': {
        for (let i = 0; i < 2; i++) {
          const settlement = buildSettlement({ orderId, amount: netAmount, fee, tax });
          await insertSettlement(pool, settlement);
          groundTruth.push({ entity_id: settlement.entity_id, order_id: orderId, category: task.category });
        }
        counts.AMBIGUOUS_DUPLICATE++;
        break;
      }

      case 'UNMATCHED': {
        // No settlement record at all.
        groundTruth.push({ entity_id: null, order_id: orderId, category: task.category });
        counts.UNMATCHED++;
        break;
      }

      case 'ON_HOLD': {
        const disputeId = randomId('disp_', 10);
        const settlement = buildSettlement({
          orderId,
          amount: netAmount,
          fee,
          tax,
          onHold: true,
          disputeId,
        });
        await insertSettlement(pool, settlement);
        groundTruth.push({ entity_id: settlement.entity_id, order_id: orderId, category: task.category });
        counts.ON_HOLD++;
        break;
      }
    }
  }

  fs.writeFileSync(GROUND_TRUTH_PATH, JSON.stringify(groundTruth, null, 2));

  await pool.end();

  // ---------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------
  console.log('\n✅ Seeding complete.\n');
  console.log('Category                | Inserted | Target | Match');
  console.log('-------------------------|----------|--------|------');
  let allMatch = true;
  for (const category of Object.keys(TARGET_COUNTS) as Category[]) {
    const inserted = counts[category];
    const target = TARGET_COUNTS[category];
    const match = inserted === target;
    if (!match) allMatch = false;
    console.log(
      `${category.padEnd(25)}| ${String(inserted).padEnd(9)}| ${String(target).padEnd(7)}| ${match ? '✅' : '❌'}`,
    );
  }
  console.log('-------------------------|----------|--------|------');
  console.log(`Total orders: ${tasks.length} (target: ${TOTAL_ORDERS})`);
  console.log(
    allMatch
      ? '✅ All categories match the target distribution.'
      : '❌ Distribution mismatch detected — see table above.',
  );
  console.log(`\nGround truth written to: ${GROUND_TRUTH_PATH}`);
}

seed().catch((err) => {
  console.error('❌ Seeding failed:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
