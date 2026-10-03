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
  -- Text picked out on the page (a selection or selected blocks) the report is about.
  context       text CHECK (length(context) <= 20000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Soft delete: rows are hidden, never removed.
  is_deleted    boolean NOT NULL DEFAULT false,
  deleted_at    timestamptz
);

-- Upgrading from 0.1: add the video column to an existing table.
ALTER TABLE shipcue_reports ADD COLUMN IF NOT EXISTS video text;

-- Upgrading from 0.2: allow agent tasks, and keep the picked-out context.
ALTER TABLE shipcue_reports ADD COLUMN IF NOT EXISTS context text CHECK (length(context) <= 20000);
ALTER TABLE shipcue_reports DROP CONSTRAINT IF EXISTS shipcue_reports_type_check;
ALTER TABLE shipcue_reports ADD CONSTRAINT shipcue_reports_type_check CHECK (type IN ('bug', 'feature', 'task'));

CREATE INDEX IF NOT EXISTS shipcue_reports_queue
  ON shipcue_reports (status, priority_rank DESC, created_at)
  WHERE NOT is_deleted;

-- Upgrading from 0.12: the CueLog's claim model. A claim names a person or an agent,
-- an agent's claim can run out (lease), a PR puts the report in review, and every
-- change is kept in shipcue_report_events.
ALTER TABLE shipcue_reports ADD COLUMN IF NOT EXISTS claimant_kind text CHECK (claimant_kind IN ('person', 'agent'));
ALTER TABLE shipcue_reports ADD COLUMN IF NOT EXISTS claimant_id text CHECK (length(claimant_id) <= 200);
ALTER TABLE shipcue_reports ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE shipcue_reports ADD COLUMN IF NOT EXISTS pr_url text CHECK (length(pr_url) <= 500);
ALTER TABLE shipcue_reports DROP CONSTRAINT IF EXISTS shipcue_reports_status_check;
ALTER TABLE shipcue_reports ADD CONSTRAINT shipcue_reports_status_check CHECK (status IN ('open', 'claimed', 'in_review', 'fixed', 'wontfix'));

CREATE INDEX IF NOT EXISTS shipcue_reports_claimant
  ON shipcue_reports (claimant_id, status) WHERE NOT is_deleted AND claimant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shipcue_reports_leases
  ON shipcue_reports (lease_expires_at) WHERE status = 'claimed' AND lease_expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS shipcue_report_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   uuid NOT NULL,
  -- The Cloud project, when the table serves many (see cloud.sql); null for one app.
  project_id  uuid,
  action      text NOT NULL CHECK (action IN ('claimed', 'assigned', 'released', 'expired', 'review', 'closed', 'reopened', 'priority', 'note', 'edited')),
  actor_kind  text CHECK (actor_kind IN ('person', 'agent')),
  actor_id    text,
  actor_name  text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS shipcue_report_events_report ON shipcue_report_events (report_id, at);
-- Keeps a report's history in the order it happened, even when two changes share a timestamp.
ALTER TABLE shipcue_report_events ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;

-- Upgrading from 0.13: anonymousLimit. Who sent a signed-out report, as a keyed hash of their
-- address (never the address), so the handler can ask them to sign in after a few.
ALTER TABLE shipcue_reports ADD COLUMN IF NOT EXISTS client_key text CHECK (length(client_key) <= 64);
CREATE INDEX IF NOT EXISTS shipcue_reports_client ON shipcue_reports (client_key) WHERE client_key IS NOT NULL AND NOT is_deleted;

-- Upgrading from 0.18: notes on a report's history, from people, agents (add_note) and shipcue
-- Cloud's hosted agent. Widens the action check to take 'note'. It sets the full current list
-- (as the block below does) so re-running this file never narrows the check over rows that use
-- a newer action ('edited').
ALTER TABLE shipcue_report_events DROP CONSTRAINT IF EXISTS shipcue_report_events_action_check;
ALTER TABLE shipcue_report_events ADD CONSTRAINT shipcue_report_events_action_check
  CHECK (action IN ('claimed', 'assigned', 'released', 'expired', 'review', 'closed', 'reopened', 'priority', 'note', 'edited'));

-- Upgrading from 0.20/0.21: editing a filed report from the CueLog (shipcue report 5c54da74).
-- No new columns; the history's action check widens to take 'edited'. Until this runs, an edit
-- fails (the history insert is refused) and everything else keeps working.
ALTER TABLE shipcue_report_events DROP CONSTRAINT IF EXISTS shipcue_report_events_action_check;
ALTER TABLE shipcue_report_events ADD CONSTRAINT shipcue_report_events_action_check
  CHECK (action IN ('claimed', 'assigned', 'released', 'expired', 'review', 'closed', 'reopened', 'priority', 'note', 'edited'));

-- Upgrading from 0.26: retry-safe filing (shipcue report 9833fd28). The panel sends one key per
-- draft and the same key when that draft is sent again (after a timeout, a stalled database);
-- the store files a key once and answers a repeat with the first report. Additive: one nullable
-- column and a unique index over the rows that have a key. Until this runs, reports file as
-- before, without the protection. On a shared (Cloud) table the key is unique per project.
ALTER TABLE shipcue_reports ADD COLUMN IF NOT EXISTS idempotency_key text CHECK (length(idempotency_key) <= 100);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'shipcue_reports'::regclass AND attname = 'project_id' AND NOT attisdropped) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS shipcue_reports_idempotency_project
      ON shipcue_reports ((coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)), idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    DROP INDEX IF EXISTS shipcue_reports_idempotency;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS shipcue_reports_idempotency
      ON shipcue_reports (idempotency_key) WHERE idempotency_key IS NOT NULL;
  END IF;
END $$;
