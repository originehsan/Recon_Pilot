// Step 6: closes a real gap - nothing in aiInvestigation/ writes to
// ai_investigations, deliberately (investigate() has no DB access by
// design). This lives in decisionGate/, not aiInvestigation/, specifically
// so the module that calls the LLM never gets write access - only the
// orchestration layer, which already has the finished result in hand,
// persists it.

import mysql from 'mysql2/promise';
import { getPool } from '../db/pool';
import { EvidenceBundle } from '../aiInvestigation/evidenceBundle';
import { AIInvestigationResult } from '../aiInvestigation/investigate';

export async function persistAIInvestigationResult(
  matchCandidateId: number,
  evidenceBundle: EvidenceBundle,
  evidenceVersion: number,
  result: AIInvestigationResult,
): Promise<number> {
  const pool = getPool();

  // Reconstructed from latencyMs rather than left to the DB's default NOW():
  // requested_at should reflect when the LLM call actually started, not
  // when this row happens to get persisted (which is slightly later).
  const completedAt = new Date();
  const requestedAt = new Date(completedAt.getTime() - result.latencyMs);

  // raw_llm_response is a JSON column, but result.rawResponse is an
  // arbitrary string - for 'invalid_output' cases specifically, it may not
  // even BE valid JSON (that's exactly why validation failed). Storing it
  // bare would make MySQL reject the insert outright for those rows. Always
  // wrapping it in an object guarantees a valid JSON document regardless of
  // what the model actually returned.
  const rawLlmResponse = result.rawResponse !== null ? JSON.stringify({ text: result.rawResponse }) : null;

  const classification = result.classification?.classification ?? null;
  const confidence = result.classification?.confidence ?? null;

  const [insertResult] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO ai_investigations
      (match_candidate_id, evidence_bundle, evidence_version, raw_llm_response, classification, confidence, status, requested_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      matchCandidateId,
      JSON.stringify(evidenceBundle),
      evidenceVersion,
      rawLlmResponse,
      classification,
      confidence,
      result.status,
      requestedAt,
      completedAt,
    ],
  );

  return insertResult.insertId;
}
