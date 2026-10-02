-- shipcue: one table holds every bug report, feature request and agent task.
-- Plain Postgres; works on Supabase, InsForge, Neon, RDS or a local server.
-- Row-level security for apps that let browsers read the table directly is
-- in supabase-rls.sql. The server handler only needs this file.

CREATE TABLE IF NOT EXISTS shipcue_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL CHECK (type IN ('bug', 'feature', 'task')),
  priority      text NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'blocking')),
  -- Sorts the queue: blocking first. Kept in step with priority by the database.
  priority_rank smallint GENERATED ALWAYS AS (
    CASE priority WHEN 'blocking' THEN 3 WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END
  ) STORED,
  area          text NOT NULL,
  description   text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 20000),
  page_url      text NOT NULL DEFAULT '' CHECK (length(page_url) <= 500),
  user_agent    text NOT NULL DEFAULT '' CHECK (length(user_agent) <= 300),
  diagnostics   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(diagnostics) <= 65536),
  -- Screenshot URLs, or small data URLs when you have no file storage.
  screenshots   text[] NOT NULL DEFAULT '{}',
  reporter      text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'fixed', 'wontfix')),
  claimed_by    text,
  claimed_at    timestamptz,
  resolution    text,
  -- A screen recording or video URL, attached after the report is filed.
  video         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Soft delete: rows are hidden, never removed.
  is_deleted    boolean NOT NULL DEFAULT false,
  deleted_at    timestamptz
);

-- Upgrading from 0.1: add the video column to an existing table.
ALTER TABLE shipcue_reports ADD COLUMN IF NOT EXISTS video text;

-- Upgrading from 0.2: allow agent tasks.
ALTER TABLE shipcue_reports DROP CONSTRAINT IF EXISTS shipcue_reports_type_check;
ALTER TABLE shipcue_reports ADD CONSTRAINT shipcue_reports_type_check CHECK (type IN ('bug', 'feature', 'task'));

CREATE INDEX IF NOT EXISTS shipcue_reports_queue
  ON shipcue_reports (status, priority_rank DESC, created_at)
  WHERE NOT is_deleted;
