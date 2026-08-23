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

export async function loadSettlementsAndOrders(): Promise<{ settlements: Settlement[]; orders: LedgerOrder[] }> {
  const pool = mysql.createPool({
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });

  try {
    const [settlementRows] = await pool.query<SettlementRow[]>(
      `SELECT id, entity_id, order_id, amount, fee, tax, settlement_utr, credit_type, dispute_id, narration
       FROM ingested_settlements
       WHERE order_id IS NOT NULL`,
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
    await pool.end();
  }
}
