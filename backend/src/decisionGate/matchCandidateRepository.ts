// Populates match_candidates. Nothing in the matching pipeline (Prompt 3)
// or the AI investigation layer (Prompt 4) ever wrote to this table - it
// ran entirely in-memory over RoutedCase/CandidatePair objects - so this
// prompt's decisionGate/audit layer has no real match_candidates row to
// reference by id when it needs one (resolutions.match_candidate_id,
// ai_investigations.match_candidate_id, review_queue.match_candidate_id all
// expect a real reference). This module is what gives every RoutedCase a
// real, idempotent match_candidates row before orchestrate.ts (Step 7)
// finalizes or queues it.
//
// One row per SETTLEMENT, not per case: match_candidates.settlement_id is
// singular and its unique key is (settlement_id, ledger_order_id), matching
// how the table was designed in the original schema (001) - a multi-
// settlement case (an ambiguous-duplicate tie, a split-payment group) gets
// one row per settlement, linked together via composite_group_id.

import mysql from 'mysql2/promise';
import { getPool } from '../db/pool';

export interface UpsertMatchCandidateInput {
  settlementId: number;
  ledgerOrderId: number | null;
  isComposite: boolean;
  fsScore: number | null;
  route: 'auto_resolve' | 'human_review' | 'ai_investigation';
  algorithmVersion: string;
}

/**
 * Idempotently ensures a match_candidates row exists for
 * (settlementId, ledgerOrderId) and returns its id.
 *
 * ledgerOrderId !== null: relies on the table's UNIQUE KEY
 * (settlement_id, ledger_order_id) plus `ON DUPLICATE KEY UPDATE
 * id = LAST_INSERT_ID(id)`, a standard MySQL idiom for "insert, or fetch
 * the existing row's id if it already exists" in one round trip.
 *
 * ledgerOrderId === null: MySQL's unique-key semantics treat every NULL as
 * distinct from every other NULL, so the ON DUPLICATE KEY trick above does
 * NOT catch a repeat call with a null ledgerOrderId (it would just insert a
 * new row every time). Looked up explicitly instead.
 */
export async function upsertMatchCandidate(input: UpsertMatchCandidateInput): Promise<number> {
  const pool = getPool();

  if (input.ledgerOrderId !== null) {
    const [result] = await pool.query<mysql.ResultSetHeader>(
      `INSERT INTO match_candidates
        (settlement_id, ledger_order_id, is_composite, fs_score, route, algorithm_version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [input.settlementId, input.ledgerOrderId, input.isComposite, input.fsScore, input.route, input.algorithmVersion],
    );
    return result.insertId;
  }

  const [existingRows] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT id FROM match_candidates WHERE settlement_id = ? AND ledger_order_id IS NULL LIMIT 1',
    [input.settlementId],
  );
  if (existingRows.length > 0) {
    return existingRows[0].id as number;
  }

  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO match_candidates
      (settlement_id, ledger_order_id, is_composite, fs_score, route, algorithm_version)
     VALUES (?, NULL, ?, ?, ?, ?)`,
    [input.settlementId, input.isComposite, input.fsScore, input.route, input.algorithmVersion],
  );
  return result.insertId;
}

/**
 * Links two or more match_candidates rows as one composite group (a
 * multi-settlement case), by setting composite_group_id to the lowest id
 * among them. There is no separate group table to mint an id from, so the
 * group's own lowest member id is used as its identifier - simple, stable,
 * and requires no additional schema.
 */
export async function linkCompositeGroup(matchCandidateIds: number[]): Promise<void> {
  if (matchCandidateIds.length < 2) {
    return;
  }

  const groupId = Math.min(...matchCandidateIds);
  const pool = getPool();
  await pool.query(`UPDATE match_candidates SET composite_group_id = ? WHERE id IN (?)`, [groupId, matchCandidateIds]);
}
