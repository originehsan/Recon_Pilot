-- 002_add_settlement_narration.sql
--
-- Adds a nullable free-text narration field to ingested_settlements. This is
-- genuine unstructured evidence for the AI investigation layer
-- (backend/src/aiInvestigation/) to reason over when disambiguating
-- ambiguous_duplicate and split_payment cases - exactly the kind of signal
-- Fellegi-Sunter and Hungarian assignment cannot use, since they only ever
-- see numeric deltas.

-- NOTE: MySQL 8.0.46 (this project's target) rejects "ADD COLUMN IF NOT
-- EXISTS" syntax outright (confirmed empirically, despite that syntax being
-- documented for some 8.0.29+ builds) - this migration is NOT self-idempotent.
-- Re-running it against a DB where narration already exists will fail with
-- "Duplicate column name". migrate.ts's schema_migrations tracking table is
-- what actually makes this safe to re-run: it only executes migrations it
-- hasn't recorded as applied.
ALTER TABLE ingested_settlements
  ADD COLUMN narration TEXT NULL AFTER credit_type;
