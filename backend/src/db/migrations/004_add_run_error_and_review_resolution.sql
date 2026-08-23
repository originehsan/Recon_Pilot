-- 004_add_run_error_and_review_resolution.sql
--
-- Two small additive schema gaps found while building the API layer
-- (backend/src/api/), both mechanically-obvious per the established pattern
-- (see 003_add_review_queue.sql) - filled directly rather than pausing for
-- confirmation, and disclosed in this prompt's summary:
--
--   1. batch_runs had no error_message column, but POST /api/runs is
--      explicitly required to store a failed run's error message somewhere
--      retrievable.
--   2. review_queue had no resolution_id column, but POST
--      /api/exceptions/:id/resolve is explicitly required to write
--      resolution_id=<the new resolution's id> onto the review_queue row
--      once a human resolves it.
--
-- NOTE: this is NOT self-idempotent (see 002's note on why) - migrate.ts's
-- schema_migrations tracking table is what makes it safe to re-run.

ALTER TABLE batch_runs
  ADD COLUMN error_message TEXT NULL AFTER progress;

ALTER TABLE review_queue
  ADD COLUMN resolution_id BIGINT NULL AFTER status;
