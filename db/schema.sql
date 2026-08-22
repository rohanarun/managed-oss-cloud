CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS billing_accounts (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  payment_method_ready BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL,
  infrastructure_monthly_cents INTEGER NOT NULL,
  platform_fee_monthly_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS installations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_resource_id TEXT UNIQUE,
  name TEXT NOT NULL,
  plan TEXT NOT NULL,
  state TEXT NOT NULL,
  hostname TEXT NOT NULL,
  app_ids JSONB NOT NULL,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE installations ADD COLUMN IF NOT EXISTS failure_reason TEXT;
CREATE INDEX IF NOT EXISTS installations_user_id_idx ON installations(user_id);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS installation_id UUID REFERENCES installations(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS worker_nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  private_address INET NOT NULL,
  machine_type TEXT NOT NULL,
  capacity_memory_mb INTEGER NOT NULL,
  capacity_cpu_millis INTEGER NOT NULL,
  capacity_storage_gb INTEGER NOT NULL DEFAULT 10,
  system_reserve_memory_mb INTEGER NOT NULL,
  agent_token_hash TEXT NOT NULL UNIQUE,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE worker_nodes ADD COLUMN IF NOT EXISTS capacity_storage_gb INTEGER NOT NULL DEFAULT 10;
ALTER TABLE installations ADD COLUMN IF NOT EXISTS worker_node_id TEXT REFERENCES worker_nodes(id) ON DELETE SET NULL;
UPDATE installations SET plan=CASE plan WHEN 'micro' THEN 'starter' WHEN 'small' THEN 'scale' WHEN 'medium' THEN 'fleet' ELSE plan END WHERE plan IN ('micro','small','medium');

CREATE TABLE IF NOT EXISTS application_instances (
  id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  state TEXT NOT NULL,
  hostname TEXT NOT NULL UNIQUE,
  container_project TEXT NOT NULL UNIQUE,
  last_health_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(installation_id, app_id)
);
CREATE INDEX IF NOT EXISTS application_instances_installation_idx ON application_instances(installation_id);
ALTER TABLE application_instances ADD COLUMN IF NOT EXISTS worker_node_id TEXT REFERENCES worker_nodes(id) ON DELETE SET NULL;
ALTER TABLE application_instances ADD COLUMN IF NOT EXISTS memory_reservation_mb INTEGER NOT NULL DEFAULT 0;
ALTER TABLE application_instances ADD COLUMN IF NOT EXISTS cpu_reservation_millis INTEGER NOT NULL DEFAULT 0;
ALTER TABLE application_instances ADD COLUMN IF NOT EXISTS storage_reservation_gb INTEGER NOT NULL DEFAULT 1;
ALTER TABLE application_instances DROP CONSTRAINT IF EXISTS application_instances_installation_id_app_id_key;
CREATE INDEX IF NOT EXISTS application_instances_worker_node_idx ON application_instances(worker_node_id, state);

CREATE TABLE IF NOT EXISTS custom_domains (
  id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  application_instance_id UUID REFERENCES application_instances(id) ON DELETE CASCADE,
  domain TEXT NOT NULL UNIQUE,
  verification_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE custom_domains ADD COLUMN IF NOT EXISTS application_instance_id UUID REFERENCES application_instances(id) ON DELETE CASCADE;
ALTER TABLE custom_domains ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS billing_ledger (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id UUID REFERENCES installations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  source_reference TEXT,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provisioning_jobs (
  id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS provisioning_jobs_claim_idx ON provisioning_jobs(status, available_at, created_at);
ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS worker_node_id TEXT REFERENCES worker_nodes(id) ON DELETE SET NULL;
ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS provisioning_jobs_worker_claim_idx ON provisioning_jobs(worker_node_id, status, available_at);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backups (
  id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  application_instance_id UUID NOT NULL REFERENCES application_instances(id) ON DELETE CASCADE,
  object_name TEXT NOT NULL UNIQUE,
  size_bytes BIGINT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS backups_installation_idx ON backups(installation_id, created_at DESC);
