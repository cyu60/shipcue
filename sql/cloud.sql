-- shipcue Cloud: one table serving many projects. Adds the project each report
-- belongs to; postgresStore(db, table, { project }) keeps every read and write to
-- one project. Rows without a project (a self-hosted queue) are untouched.
ALTER TABLE shipcue_reports ADD COLUMN IF NOT EXISTS project_id uuid;

CREATE INDEX IF NOT EXISTS shipcue_reports_project_queue
  ON shipcue_reports (project_id, status, priority_rank DESC, created_at)
  WHERE NOT is_deleted;
