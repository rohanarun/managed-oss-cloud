CREATE TABLE IF NOT EXISTS suite_workspaces (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'none',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (plan IN ('none', 'starter', 'scale', 'fleet'))
);
ALTER TABLE suite_workspaces ALTER COLUMN plan SET DEFAULT 'none';
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='suite_workspaces'::regclass
      AND conname='suite_workspaces_plan_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%none%'
  ) THEN
    ALTER TABLE suite_workspaces DROP CONSTRAINT suite_workspaces_plan_check;
    ALTER TABLE suite_workspaces ADD CONSTRAINT suite_workspaces_plan_check CHECK (plan IN ('none', 'starter', 'scale', 'fleet'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS suite_workspace_members (
  workspace_id UUID NOT NULL REFERENCES suite_workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id),
  UNIQUE (user_id),
  CHECK (role IN ('owner', 'admin', 'member', 'viewer'))
);
INSERT INTO suite_workspace_members(workspace_id,user_id,role)
SELECT id,user_id,'owner' FROM suite_workspaces
ON CONFLICT (user_id) DO NOTHING;
CREATE INDEX IF NOT EXISTS suite_workspace_members_workspace_idx ON suite_workspace_members(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS suite_custom_domains (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES suite_workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'awaiting-dns',
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('awaiting-dns', 'verified', 'active'))
);
CREATE INDEX IF NOT EXISTS suite_custom_domains_workspace_idx ON suite_custom_domains(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS suite_workspace_modules (
  workspace_id UUID NOT NULL REFERENCES suite_workspaces(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, module_id)
);

CREATE TABLE IF NOT EXISTS suite_records (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES suite_workspaces(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS suite_records_workspace_module_idx ON suite_records(workspace_id, module_id, record_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS suite_records_data_idx ON suite_records USING GIN(data);
CREATE UNIQUE INDEX IF NOT EXISTS suite_consent_public_idempotency_idx
  ON suite_records(workspace_id, (data->>'publicIdempotencyHash'))
  WHERE module_id='consent' AND record_type='consent-receipt' AND data ? 'publicIdempotencyHash';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='suite_records_workspace_id_id_key') THEN
    ALTER TABLE suite_records ADD CONSTRAINT suite_records_workspace_id_id_key UNIQUE(workspace_id,id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS suite_events (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES suite_workspaces(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  record_id UUID REFERENCES suite_records(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS suite_events_workspace_idx ON suite_events(workspace_id, created_at DESC);
ALTER TABLE suite_events DROP CONSTRAINT IF EXISTS suite_events_record_id_fkey;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='suite_events_workspace_record_fkey') THEN
    ALTER TABLE suite_events ADD CONSTRAINT suite_events_workspace_record_fkey FOREIGN KEY(workspace_id,record_id) REFERENCES suite_records(workspace_id,id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS suite_ai_actions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES suite_workspaces(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued',
  result JSONB,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('queued', 'running', 'completed', 'failed'))
);
ALTER TABLE suite_ai_actions ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE suite_ai_actions ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE suite_ai_actions ADD COLUMN IF NOT EXISTS last_error TEXT;
CREATE INDEX IF NOT EXISTS suite_ai_actions_queue_idx ON suite_ai_actions(status, created_at);

CREATE TABLE IF NOT EXISTS suite_api_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['read','write','ai']::TEXT[],
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
ALTER TABLE suite_api_tokens ADD COLUMN IF NOT EXISTS scopes TEXT[];
ALTER TABLE suite_api_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE suite_api_tokens SET scopes=ARRAY['read','write','ai']::TEXT[] WHERE scopes IS NULL;
UPDATE suite_api_tokens SET expires_at=created_at+INTERVAL '90 days' WHERE expires_at IS NULL;
ALTER TABLE suite_api_tokens ALTER COLUMN scopes SET DEFAULT ARRAY['read','write','ai']::TEXT[];
ALTER TABLE suite_api_tokens ALTER COLUMN scopes SET NOT NULL;
ALTER TABLE suite_api_tokens ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '90 days');
ALTER TABLE suite_api_tokens ALTER COLUMN expires_at SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='suite_api_tokens_scopes_check') THEN
    ALTER TABLE suite_api_tokens ADD CONSTRAINT suite_api_tokens_scopes_check CHECK (CARDINALITY(scopes) BETWEEN 1 AND 3 AND scopes <@ ARRAY['read','write','ai']::TEXT[]);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS suite_api_tokens_user_idx ON suite_api_tokens(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS suite_record_links (
  workspace_id UUID NOT NULL REFERENCES suite_workspaces(id) ON DELETE CASCADE,
  source_record_id UUID NOT NULL REFERENCES suite_records(id) ON DELETE CASCADE,
  target_record_id UUID NOT NULL REFERENCES suite_records(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_record_id, target_record_id, relationship),
  CHECK (source_record_id <> target_record_id)
);
ALTER TABLE suite_record_links DROP CONSTRAINT IF EXISTS suite_record_links_source_record_id_fkey;
ALTER TABLE suite_record_links DROP CONSTRAINT IF EXISTS suite_record_links_target_record_id_fkey;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='suite_record_links_source_workspace_fkey') THEN
    ALTER TABLE suite_record_links ADD CONSTRAINT suite_record_links_source_workspace_fkey FOREIGN KEY(workspace_id,source_record_id) REFERENCES suite_records(workspace_id,id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='suite_record_links_target_workspace_fkey') THEN
    ALTER TABLE suite_record_links ADD CONSTRAINT suite_record_links_target_workspace_fkey FOREIGN KEY(workspace_id,target_record_id) REFERENCES suite_records(workspace_id,id) ON DELETE CASCADE;
  END IF;
END $$;
