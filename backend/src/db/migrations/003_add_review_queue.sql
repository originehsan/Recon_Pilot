-- 003_add_review_queue.sql
--
-- The decision gate (backend/src/decisionGate/) routes any case it cannot
-- safely auto-finalize here instead. No schema for this existed before this
-- migration - the columns below match exactly what
-- backend/src/decisionGate/reviewQueue.ts's enqueueForReview() writes: a
-- pointer to the representative match_candidates row, a reason, and a
-- priority signal. Richer detail for multi-settlement cases (the full list
-- of settlement ids involved, case type, etc.) is not duplicated here - it
-- lives in the paired audit_events row's decision_gate_output instead.

CREATE TABLE IF NOT EXISTS review_queue (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  match_candidate_id BIGINT NULL,
  reason_code VARCHAR(64),
  exposure_amount DECIMAL(14,2),
  priority_score DECIMAL(18,8),
  status ENUM('pending', 'resolved', 'dismissed') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
