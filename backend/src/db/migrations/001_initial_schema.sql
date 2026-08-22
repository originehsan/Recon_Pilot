-- 001_initial_schema.sql
-- Initial schema for the settlement reconciliation system.

CREATE TABLE IF NOT EXISTS ingested_settlements (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  batch_id BIGINT,
  entity_id VARCHAR(64),
  type VARCHAR(32),
  settlement_id VARCHAR(64) NULL,
  settlement_utr VARCHAR(64) NULL,
  order_id VARCHAR(64) NULL,
  payment_id VARCHAR(64) NULL,
  amount DECIMAL(14,2),
  fee DECIMAL(14,2) DEFAULT 0,
  tax DECIMAL(14,2) DEFAULT 0,
  on_hold BOOLEAN DEFAULT FALSE,
  dispute_id VARCHAR(64) NULL,
  credit_type VARCHAR(32) NULL,
  raw_payload JSON,
  content_hash CHAR(64),
  idempotency_key VARCHAR(255),
  ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ingested_settlements_settlement_utr (settlement_utr),
  UNIQUE KEY uq_ingested_settlements_idempotency_key (idempotency_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ledger_orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  batch_id BIGINT,
  order_id VARCHAR(64),
  expected_amount DECIMAL(14,2),
  expected_reference VARCHAR(64) NULL,
  expected_date DATE NULL,
  raw_payload JSON,
  UNIQUE KEY uq_ledger_orders_order_id (order_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS partial_payment_groups (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  group_uuid CHAR(36) UNIQUE,
  order_id BIGINT,
  expected_amount DECIMAL(14,2),
  solution_count INT,
  status ENUM('UNIQUE_SOLUTION', 'AMBIGUOUS', 'NO_SOLUTION')
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS partial_payment_items (
  group_id BIGINT,
  settlement_id BIGINT,
  amount DECIMAL(14,2),
  PRIMARY KEY (group_id, settlement_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS match_candidates (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  settlement_id BIGINT,
  ledger_order_id BIGINT NULL,
  is_composite BOOLEAN DEFAULT FALSE,
  composite_group_id BIGINT NULL,
  ambiguity_component_id BIGINT NULL,
  string_similarity DECIMAL(12,8) NULL,
  amount_delta DECIMAL(18,2) NULL,
  date_delta_seconds BIGINT NULL,
  fs_score DECIMAL(18,8),
  route ENUM('auto_resolve', 'human_review', 'ai_investigation'),
  algorithm_version VARCHAR(32),
  UNIQUE KEY uq_match_candidates_settlement_ledger_order (settlement_id, ledger_order_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ai_investigations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  match_candidate_id BIGINT,
  evidence_bundle JSON,
  evidence_version BIGINT,
  raw_llm_response JSON NULL,
  classification VARCHAR(32) NULL,
  confidence DECIMAL(5,4) NULL,
  status ENUM('success', 'timeout', 'error', 'invalid_output', 'stale_evidence'),
  requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS resolutions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  settlement_id BIGINT,
  ledger_order_id BIGINT NULL,
  match_candidate_id BIGINT NULL,
  ai_investigation_id BIGINT NULL,
  final_status ENUM('matched', 'rejected', 'unresolved'),
  decided_by ENUM('stage1_exact', 'stage7_auto', 'post_ai', 'human'),
  evidence_version BIGINT,
  evidence_hash CHAR(64),
  supersedes_resolution_id BIGINT NULL,
  decided_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(64),
  entity_id BIGINT,
  stage VARCHAR(32),
  actor_type ENUM('SYSTEM', 'AI', 'HUMAN', 'DECISION_GATE'),
  evidence_used JSON NULL,
  ai_raw_output JSON NULL,
  decision_gate_output JSON NULL,
  sequence_no BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  provider VARCHAR(32),
  event_id VARCHAR(128),
  payload JSON,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_webhook_events_provider_event (provider, event_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS batch_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
  progress JSON NULL,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
