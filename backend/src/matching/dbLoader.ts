// Shared DB-loading helpers for the matching pipeline's verification
// scripts (manualVerify.ts, verifyFullPipeline.ts).

import mysql from 'mysql2/promise';
import { config } from '../config';
import { LedgerOrder, Settlement } from './types';

interface SettlementRow extends mysql.RowDataPacket {
  id: number;
  entity_id: string;
  order_id: string | null;
  amount: string;
  fee: string;
  tax: string;
  settlement_utr: string | null;
  credit_type: string | null;
  dispute_id: string | null;
  narration: string | null;
}

interface LedgerOrderRow extends mysql.RowDataPacket {
  id: number;
  order_id: string;
  expected_amount: string;
  expected_date: string | null;
}

/**
 * MySQL DECIMAL(14,2) columns come back from mysql2 as strings by default -
 * on purpose, since parsing them straight to a JS float would reintroduce
 * exactly the floating-point rounding risk the matching pipeline is written
 * to avoid (0.1 + 0.2 !== 0.3). This converts a "123456.78"-style string
 * into an exact integer by scaling by 100 (this schema always has exactly 2
 * fractional digits), so every downstream comparison can use plain integer
 * equality.
 */
export function decimalStringToInt(value: string): number {
  const [wholePartRaw, fractionPartRaw = ''] = value.split('.');
  const isNegative = wholePartRaw.startsWith('-');
  const wholeDigits = wholePartRaw.replace('-', '') || '0';
  const fractionDigits = fractionPartRaw.padEnd(2, '0').slice(0, 2);
  const magnitude = Number(wholeDigits) * 100 + Number(fractionDigits);
  return isNegative ? -magnitude : magnitude;
}

export interface LoadSettlementsAndOrdersOptions {
  /**
   * When true, excludes any settlement that already has a non-superseded
   * resolutions row (the same head-of-chain definition decisionGate.ts's
   * getCurrentResolution uses) - i.e. only genuinely unresolved settlements
   * are loaded.
   *
   * Defaults to false (the original, unfiltered behavior) rather than
   * changing unconditionally: verifyDecisionGate.ts's ground-truth
   * cross-checks build their entityId->settlementId map from this same
   * function's return value and need every seeded settlement present to
   * check against ground-truth.json, even ones a previous run already
   * resolved (those checks read persisted DB state, not this function's
   * return value, for what actually got decided - they just need the full
   * id/entityId map to do it). Only backend/src/api/routes/runs.ts (the
   * live POST /api/runs route) opts in - that's the one place where
   * silently re-processing already-resolved settlements on every run was a
   * real, user-visible bug (inflated "Total Cases" counts, and redundant
   * audit-log growth - see decisionGate.ts's matching fix).
   */
  excludeResolved?: boolean;
}

/**
 * `poolOverride` exists ONLY so dbLoader.test.ts can inject a fake pool and
 * unit-test the excludeResolved SQL toggle without a real DB connection -
 * every real call site (all 5 of them, unchanged) omits it and gets
 * EXACTLY the same own-pool-per-call behavior as before this parameter was
 * added: a fresh pool is created and closed on every call either way.
 */
export async function loadSettlementsAndOrders(
  options: LoadSettlementsAndOrdersOptions = {},
  poolOverride?: Pick<mysql.Pool, 'query' | 'end'>,
): Promise<{ settlements: Settlement[]; orders: LedgerOrder[] }> {
  const pool =
    poolOverride ??
    mysql.createPool({
      host: config.db.host,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
    });

  try {
    // NOT EXISTS(...NOT EXISTS...) mirrors decisionGate.ts's own
    // getCurrentResolution head-of-chain definition exactly: "has a
    // resolutions row that nothing else supersedes" - deliberately the same
    // SQL shape rather than a different ad-hoc "is resolved" check, so the
    // two places this project decides "is this settlement done" can never
    // silently drift apart.
    const excludeResolvedClause = options.excludeResolved
      ? `AND NOT EXISTS (
           SELECT 1 FROM resolutions r
           WHERE r.settlement_id = ingested_settlements.id
             AND NOT EXISTS (SELECT 1 FROM resolutions r2 WHERE r2.supersedes_resolution_id = r.id)
         )`
      : '';

    const [settlementRows] = await pool.query<SettlementRow[]>(
      `SELECT id, entity_id, order_id, amount, fee, tax, settlement_utr, credit_type, dispute_id, narration
       FROM ingested_settlements
       WHERE order_id IS NOT NULL
       ${excludeResolvedClause}`,
    );

    const [orderRows] = await pool.query<LedgerOrderRow[]>(
      `SELECT id, order_id, expected_amount, DATE_FORMAT(expected_date, '%Y-%m-%d') AS expected_date
       FROM ledger_orders`,
    );

    const settlements: Settlement[] = settlementRows.map((row) => ({
      id: row.id,
      entityId: row.entity_id,
      orderId: row.order_id as string,
      amount: decimalStringToInt(row.amount),
      fee: decimalStringToInt(row.fee),
      tax: decimalStringToInt(row.tax),
      settlementUtr: row.settlement_utr,
      creditType: row.credit_type,
      hasDispute: row.dispute_id !== null,
      narration: row.narration,
    }));

    const orders: LedgerOrder[] = orderRows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      expectedAmount: decimalStringToInt(row.expected_amount),
      expectedDate: row.expected_date,
    }));

    return { settlements, orders };
  } finally {
    // Only close a pool this function created itself - never a caller-owned
    // override (a test's fake pool, or a future real shared-pool caller).
    if (!poolOverride) {
      await (pool as mysql.Pool).end();
    }
  }
}
