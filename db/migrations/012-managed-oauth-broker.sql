CREATE TABLE managed_oauth_flows (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32,128}$'),
  state_token_hash CHAR(64) NOT NULL UNIQUE CHECK (state_token_hash ~ '^[a-f0-9]{64}$'),
  application_instance_id UUID NOT NULL REFERENCES application_instances(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin ~ '^https://[^/?#]+$' AND length(origin) <= 2048),
  upstream_state TEXT NOT NULL CHECK (length(upstream_state) BETWEEN 8 AND 2000),
  code_verifier TEXT NOT NULL CHECK (code_verifier ~ '^[A-Za-z0-9_-]{43,128}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX managed_oauth_flows_expiry_idx ON managed_oauth_flows(expires_at) WHERE consumed_at IS NULL;
ALTER TABLE managed_oauth_flows OWNER TO managed_oss_core_owner;
REVOKE ALL ON TABLE managed_oauth_flows FROM PUBLIC,managed_oss_runtime,managed_oss_ai;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE managed_oauth_flows TO managed_oss_control;

COMMENT ON TABLE managed_oauth_flows IS 'Single-use hosting-layer OAuth state. Provider credentials and assertion signing keys never enter tenant application containers.';
