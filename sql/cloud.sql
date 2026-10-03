-- shipcue Cloud: one table serving many projects. Adds the project each report
-- belongs to; postgresStore(db, table, { project }) keeps every read and write to
-- one project. Rows without a project (a self-hosted queue) are untouched.
ALTER TABLE shipcue_reports ADD COLUMN IF NOT EXISTS project_id uuid;

CREATE INDEX IF NOT EXISTS shipcue_reports_project_queue
  ON shipcue_reports (project_id, status, priority_rank DESC, created_at)
  WHERE NOT is_deleted;

-- The hosted side: projects (one per app), their team, invites and agents. Only the
-- Cloud's server reads these, over its own connection; browsers never do.

CREATE TABLE IF NOT EXISTS cloud_projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  -- In the button's endpoint; it can file reports, never read them.
  public_key      text NOT NULL UNIQUE CHECK (public_key ~ '^pk_[0-9a-f]{24}$'),
  -- Sites the button may file from, e.g. {https://app.example.com}.
  allowed_origins text[] NOT NULL DEFAULT '{}',
  -- How long an agent's claim lasts without a heartbeat; null for no lease.
  lease_seconds   integer DEFAULT 7200 CHECK (lease_seconds IS NULL OR lease_seconds BETWEEN 60 AND 604800),
  -- A person's claim shows "stale" after this many days.
  stale_days      integer NOT NULL DEFAULT 3 CHECK (stale_days BETWEEN 1 AND 365),
  -- Agents take unassigned work unless they or the project say otherwise.
  agent_pull      boolean NOT NULL DEFAULT true,
  -- The parts of the app a report can be about: [{"value": "editor", "label": "Editor"}].
  areas           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(areas) = 'array'),
  -- Show the public CueLog (queue and changelog) at /api/cloud/p/<key>/board.
  public_board    boolean NOT NULL DEFAULT false,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  is_deleted      boolean NOT NULL DEFAULT false,
  deleted_at      timestamptz
);

CREATE TABLE IF NOT EXISTS cloud_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES cloud_projects (id),
  user_id     uuid NOT NULL,
  email       text NOT NULL CHECK (length(email) <= 320),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  role        text NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  is_deleted  boolean NOT NULL DEFAULT false,
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_members_one_per_project ON cloud_members (project_id, user_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS cloud_members_user ON cloud_members (user_id) WHERE NOT is_deleted;

CREATE TABLE IF NOT EXISTS cloud_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES cloud_projects (id),
  email       text NOT NULL CHECK (length(email) <= 320),
  role        text NOT NULL CHECK (role IN ('member', 'viewer', 'owner')),
  invited_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS cloud_invites_email ON cloud_invites (lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS cloud_agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES cloud_projects (id),
  name          text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9._@-]{0,59}$'),
  -- sha256 of the agent's token; the token itself is shown once and never stored.
  token_hash    text NOT NULL UNIQUE,
  -- The member who connected it, shown next to its name.
  owner_user_id uuid NOT NULL,
  owner_name    text NOT NULL,
  -- null: the project's agent_pull.
  pull          boolean,
  -- null: every type.
  types         text[] CHECK (types IS NULL OR types <@ ARRAY['bug', 'feature', 'task']),
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS cloud_agents_project ON cloud_agents (project_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cloud_agents_one_name ON cloud_agents (project_id, name) WHERE revoked_at IS NULL;

-- Forwarding: where a project's reports are announced. Server only, like everything here.
ALTER TABLE cloud_projects ADD COLUMN IF NOT EXISTS slack_webhook_url text CHECK (slack_webhook_url IS NULL OR slack_webhook_url ~ '^https://hooks\.slack\.com/');
ALTER TABLE cloud_projects ADD COLUMN IF NOT EXISTS webhook_url text CHECK (webhook_url IS NULL OR (webhook_url ~ '^https://' AND length(webhook_url) <= 500));
ALTER TABLE cloud_projects ADD COLUMN IF NOT EXISTS webhook_secret text;
ALTER TABLE cloud_projects ADD COLUMN IF NOT EXISTS notify_events text[] NOT NULL DEFAULT '{report.filed,report.closed}';

-- The hosted agent (shipcue report 3d2dded6): a built-in "shipcue-agent" each project can turn on.
-- It is a cloud_agents row with no token (hosted), so assigning, claiming and history work as for any agent.
ALTER TABLE cloud_projects ADD COLUMN IF NOT EXISTS hosted_agent boolean NOT NULL DEFAULT false;
-- Triage every new report, not only the ones assigned to it.
ALTER TABLE cloud_projects ADD COLUMN IF NOT EXISTS hosted_auto_triage boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_agents ADD COLUMN IF NOT EXISTS hosted boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_agents ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE cloud_agents DROP CONSTRAINT IF EXISTS cloud_agents_token_or_hosted;
ALTER TABLE cloud_agents ADD CONSTRAINT cloud_agents_token_or_hosted CHECK (hosted OR token_hash IS NOT NULL);
-- The daily cap counts the hosted agent's notes.
CREATE INDEX IF NOT EXISTS shipcue_report_events_notes ON shipcue_report_events (project_id, actor_id, at) WHERE action = 'note';

-- The activity digest (shipcue report 5f4d339b): one summary per hour or day, to the project's Slack
-- channel or the first owner's email, sent by the Cloud's cron (/api/cloud/digest). digest_sent_at is
-- the end of the last period sent, so the next digest starts there.
ALTER TABLE cloud_projects ADD COLUMN IF NOT EXISTS digest_every text NOT NULL DEFAULT 'off' CHECK (digest_every IN ('off', 'hour', 'day'));
ALTER TABLE cloud_projects ADD COLUMN IF NOT EXISTS digest_to text NOT NULL DEFAULT 'slack' CHECK (digest_to IN ('slack', 'email'));
ALTER TABLE cloud_projects ADD COLUMN IF NOT EXISTS digest_sent_at timestamptz;

-- The GitHub webhook (shipcue report 919f5ca2): a pull_request webhook at /api/cloud/p/<key>/github,
-- signed with this secret (shown once). Null: off.
ALTER TABLE cloud_projects ADD COLUMN IF NOT EXISTS github_secret text;

-- Server only: row-level security on with no policies, and no grants to browser roles.
ALTER TABLE cloud_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipcue_report_events ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON cloud_projects, cloud_members, cloud_invites, cloud_agents, shipcue_report_events FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON cloud_projects, cloud_members, cloud_invites, cloud_agents, shipcue_report_events FROM authenticated;
  END IF;
END $$;
REVOKE ALL ON cloud_projects, cloud_members, cloud_invites, cloud_agents, shipcue_report_events FROM PUBLIC;
