-- 002_add_settlement_narration.sql
--
-- Adds a nullable free-text narration field to ingested_settlements. This is
-- genuine unstructured evidence for the AI investigation layer
-- (backend/src/aiInvestigation/) to reason over when disambiguating
-- ambiguous_duplicate and split_payment cases - exactly the kind of signal
-- Fellegi-Sunter and Hungarian assignment cannot use, since they only ever
-- see numeric deltas.

ALTER TABLE ingested_settlements
  ADD COLUMN narration TEXT NULL AFTER credit_type;
