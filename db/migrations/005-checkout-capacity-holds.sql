CREATE TABLE checkout_capacity_holds (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  requested_plan TEXT NOT NULL,
  requested_app_ids JSONB NOT NULL,
  infrastructure_monthly_cents INTEGER NOT NULL,
  platform_fee_monthly_cents INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id TEXT,
  stripe_checkout_session_id TEXT,
  stripe_checkout_expires_at TIMESTAMPTZ,
  provider_subscription_id TEXT,
  checkout_session_attached_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  release_reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT checkout_capacity_holds_state_check CHECK (state IN ('active','consumed','released','expired')),
  CONSTRAINT checkout_capacity_holds_requested_apps_check CHECK (jsonb_typeof(requested_app_ids)='array'),
  CONSTRAINT checkout_capacity_holds_price_check CHECK (infrastructure_monthly_cents>0 AND platform_fee_monthly_cents>0),
  CONSTRAINT checkout_capacity_holds_expiry_check CHECK (expires_at>created_at),
  CONSTRAINT checkout_capacity_holds_session_expiry_check CHECK (stripe_checkout_expires_at IS NULL OR (stripe_checkout_session_id IS NOT NULL AND stripe_checkout_expires_at>created_at AND stripe_checkout_expires_at<=expires_at)),
  CONSTRAINT checkout_capacity_holds_terminal_check CHECK (
    (state='active' AND consumed_at IS NULL AND released_at IS NULL AND expired_at IS NULL AND provider_subscription_id IS NULL)
    OR (state='consumed' AND consumed_at IS NOT NULL AND released_at IS NULL AND expired_at IS NULL AND provider_subscription_id IS NOT NULL)
    OR (state='released' AND consumed_at IS NULL AND released_at IS NOT NULL AND expired_at IS NULL AND provider_subscription_id IS NULL)
    OR (state='expired' AND consumed_at IS NULL AND released_at IS NULL AND expired_at IS NOT NULL AND provider_subscription_id IS NULL)
  ),
  UNIQUE(user_id,idempotency_key),
  UNIQUE(stripe_checkout_session_id),
  UNIQUE(provider_subscription_id)
);

CREATE UNIQUE INDEX checkout_capacity_holds_one_active_installation_idx
  ON checkout_capacity_holds(installation_id)
  WHERE state='active';
CREATE INDEX checkout_capacity_holds_active_expiry_idx
  ON checkout_capacity_holds(expires_at,installation_id)
  WHERE state='active';

CREATE TABLE checkout_capacity_hold_items (
  id UUID PRIMARY KEY,
  hold_id UUID NOT NULL REFERENCES checkout_capacity_holds(id) ON DELETE CASCADE,
  application_instance_id UUID NOT NULL REFERENCES application_instances(id) ON DELETE CASCADE,
  worker_node_id TEXT NOT NULL REFERENCES worker_nodes(id) ON DELETE RESTRICT,
  app_id TEXT NOT NULL,
  memory_reservation_mb INTEGER NOT NULL CHECK (memory_reservation_mb>0),
  cpu_reservation_millis INTEGER NOT NULL CHECK (cpu_reservation_millis>0),
  storage_reservation_gb INTEGER NOT NULL CHECK (storage_reservation_gb>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(hold_id,application_instance_id)
);

CREATE INDEX checkout_capacity_hold_items_worker_idx
  ON checkout_capacity_hold_items(worker_node_id,hold_id);

CREATE FUNCTION managed_oss_protect_checkout_capacity_hold()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF ROW(OLD.id,OLD.user_id,OLD.installation_id,OLD.idempotency_key,OLD.requested_plan,OLD.requested_app_ids,OLD.infrastructure_monthly_cents,OLD.platform_fee_monthly_cents,OLD.expires_at,OLD.created_at)
     IS DISTINCT FROM ROW(NEW.id,NEW.user_id,NEW.installation_id,NEW.idempotency_key,NEW.requested_plan,NEW.requested_app_ids,NEW.infrastructure_monthly_cents,NEW.platform_fee_monthly_cents,NEW.expires_at,NEW.created_at) THEN
    RAISE EXCEPTION 'checkout capacity hold snapshot is immutable';
  END IF;
  IF OLD.state<>'active' AND ROW(OLD.state,OLD.stripe_customer_id,OLD.stripe_checkout_session_id,OLD.stripe_checkout_expires_at,OLD.provider_subscription_id,OLD.consumed_at,OLD.released_at,OLD.expired_at,OLD.release_reason)
     IS DISTINCT FROM ROW(NEW.state,NEW.stripe_customer_id,NEW.stripe_checkout_session_id,NEW.stripe_checkout_expires_at,NEW.provider_subscription_id,NEW.consumed_at,NEW.released_at,NEW.expired_at,NEW.release_reason) THEN
    RAISE EXCEPTION 'terminal checkout capacity hold is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION managed_oss_protect_checkout_capacity_hold_item()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'checkout capacity hold allocation is immutable';
END
$function$;

CREATE TRIGGER checkout_capacity_holds_immutable_snapshot BEFORE UPDATE ON checkout_capacity_holds FOR EACH ROW EXECUTE FUNCTION managed_oss_protect_checkout_capacity_hold();
CREATE TRIGGER checkout_capacity_hold_items_immutable BEFORE UPDATE ON checkout_capacity_hold_items FOR EACH ROW EXECUTE FUNCTION managed_oss_protect_checkout_capacity_hold_item();

REVOKE ALL ON TABLE checkout_capacity_holds,checkout_capacity_hold_items FROM PUBLIC;
REVOKE ALL ON FUNCTION managed_oss_protect_checkout_capacity_hold(),managed_oss_protect_checkout_capacity_hold_item() FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE checkout_capacity_holds,checkout_capacity_hold_items TO managed_oss_runtime;
