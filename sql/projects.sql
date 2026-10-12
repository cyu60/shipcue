-- One table serving many queues (shipcue Cloud, or any host with several apps): adds the project
-- each report belongs to; postgresStore(db, table, { project }) keeps every read and write to one
-- project. Rows without a project (a self-hosted queue) are untouched. Run after schema.sql; safe to repeat.
ALTER TABLE shipcue_reports ADD COLUMN IF NOT EXISTS project_id uuid;

CREATE INDEX IF NOT EXISTS shipcue_reports_project_queue
  ON shipcue_reports (project_id, status, priority_rank DESC, created_at)
  WHERE NOT is_deleted;

-- Retry-safe filing (shipcue report 9833fd28, "Upgrading from 0.26" in schema.sql): one key per
-- draft, unique per project, so the same key in two projects files two reports.
ALTER TABLE shipcue_reports ADD COLUMN IF NOT EXISTS idempotency_key text CHECK (length(idempotency_key) <= 100);
CREATE UNIQUE INDEX IF NOT EXISTS shipcue_reports_idempotency_project
  ON shipcue_reports ((coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)), idempotency_key)
  WHERE idempotency_key IS NOT NULL;
DROP INDEX IF EXISTS shipcue_reports_idempotency;
