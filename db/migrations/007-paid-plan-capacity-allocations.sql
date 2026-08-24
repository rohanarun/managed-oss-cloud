-- A subscription buys a complete, durable logical plan quota. Application rows
-- consume that quota and are the exact physical worker-level reservations.
-- Existing paid installations are deliberately not mutated in SQL: the migration
-- command performs the runtime-plan-aware, transactionally locked legacy backfill
-- after these tables and their constraints exist.

CREATE TABLE checkout_plan_capacity_holds (
  hold_id UUID PRIMARY KEY REFERENCES checkout_capacity_holds(id) ON DELETE CASCADE,
  worker_node_id TEXT NOT NULL REFERENCES worker_nodes(id) ON DELETE RESTRICT,
  requested_plan TEXT NOT NULL CHECK (length(requested_plan)>0),
  allocation_memory_mb INTEGER NOT NULL CHECK (allocation_memory_mb>0),
  allocation_cpu_millis INTEGER NOT NULL CHECK (allocation_cpu_millis>0),
  allocation_storage_gb INTEGER NOT NULL CHECK (allocation_storage_gb>0),
  allocation_max_services INTEGER NOT NULL CHECK (allocation_max_services>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX checkout_plan_capacity_holds_worker_idx
  ON checkout_plan_capacity_holds(worker_node_id,hold_id);

COMMENT ON TABLE checkout_plan_capacity_holds IS
  'Immutable logical paid-plan quota snapshots plus an affinity worker; checkout_capacity_hold_items are the physical worker reservations.';

CREATE TABLE installation_capacity_allocations (
  id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE RESTRICT,
  worker_node_id TEXT NOT NULL REFERENCES worker_nodes(id) ON DELETE RESTRICT,
  plan TEXT NOT NULL CHECK (length(plan)>0),
  allocation_memory_mb INTEGER NOT NULL CHECK (allocation_memory_mb>0),
  allocation_cpu_millis INTEGER NOT NULL CHECK (allocation_cpu_millis>0),
  allocation_storage_gb INTEGER NOT NULL CHECK (allocation_storage_gb>0),
  allocation_max_services INTEGER NOT NULL CHECK (allocation_max_services>0),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation>0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended','released')),
  source_checkout_hold_id UUID REFERENCES checkout_capacity_holds(id) ON DELETE RESTRICT,
  suspended_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT installation_capacity_allocation_state_check CHECK (
    (state='active' AND suspended_at IS NULL AND released_at IS NULL AND release_reason IS NULL)
    OR (state='suspended' AND suspended_at IS NOT NULL AND released_at IS NULL AND release_reason IS NOT NULL)
    OR (state='released' AND released_at IS NOT NULL AND release_reason IS NOT NULL)
  ),
  UNIQUE(source_checkout_hold_id)
);

CREATE UNIQUE INDEX installation_capacity_allocations_one_current_idx
  ON installation_capacity_allocations(installation_id)
  WHERE state IN ('active','suspended');
CREATE INDEX installation_capacity_allocations_worker_idx
  ON installation_capacity_allocations(worker_node_id,state);

COMMENT ON TABLE installation_capacity_allocations IS
  'Durable logical per-installation paid-plan quotas. Physical worker commitment is derived only from assigned application instances and active checkout hold items.';

CREATE TABLE plan_capacity_change_holds (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE RESTRICT,
  allocation_id UUID NOT NULL REFERENCES installation_capacity_allocations(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  expected_generation BIGINT NOT NULL CHECK (expected_generation>0),
  from_plan TEXT NOT NULL CHECK (length(from_plan)>0),
  requested_plan TEXT NOT NULL CHECK (length(requested_plan)>0),
  worker_node_id TEXT NOT NULL REFERENCES worker_nodes(id) ON DELETE RESTRICT,
  target_memory_mb INTEGER NOT NULL CHECK (target_memory_mb>0),
  target_cpu_millis INTEGER NOT NULL CHECK (target_cpu_millis>0),
  target_storage_gb INTEGER NOT NULL CHECK (target_storage_gb>0),
  target_max_services INTEGER NOT NULL CHECK (target_max_services>0),
  reserved_delta_memory_mb INTEGER NOT NULL CHECK (reserved_delta_memory_mb>=0),
  reserved_delta_cpu_millis INTEGER NOT NULL CHECK (reserved_delta_cpu_millis>=0),
  reserved_delta_storage_gb INTEGER NOT NULL CHECK (reserved_delta_storage_gb>=0),
  infrastructure_monthly_cents INTEGER NOT NULL CHECK (infrastructure_monthly_cents>0),
  platform_fee_monthly_cents INTEGER NOT NULL CHECK (platform_fee_monthly_cents>0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','consumed','released','expired')),
  provider_subscription_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  release_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT plan_capacity_change_hold_expiry_check CHECK (expires_at>created_at),
  CONSTRAINT plan_capacity_change_hold_state_check CHECK (
    (state='active' AND consumed_at IS NULL AND released_at IS NULL AND expired_at IS NULL AND release_reason IS NULL)
    OR (state='consumed' AND consumed_at IS NOT NULL AND released_at IS NULL AND expired_at IS NULL)
    OR (state='released' AND consumed_at IS NULL AND released_at IS NOT NULL AND expired_at IS NULL AND release_reason IS NOT NULL)
    OR (state='expired' AND consumed_at IS NULL AND released_at IS NULL AND expired_at IS NOT NULL)
  ),
  UNIQUE(user_id,idempotency_key)
);

CREATE UNIQUE INDEX plan_capacity_change_holds_one_active_installation_idx
  ON plan_capacity_change_holds(installation_id)
  WHERE state='active';
CREATE INDEX plan_capacity_change_holds_worker_idx
  ON plan_capacity_change_holds(worker_node_id,state,expires_at);

COMMENT ON TABLE plan_capacity_change_holds IS
  'Immutable logical plan-quota changes. reserved_delta columns describe quota headroom and do not reserve physical worker capacity.';

CREATE TABLE installation_capacity_allocation_events (
  id UUID PRIMARY KEY,
  allocation_id UUID NOT NULL REFERENCES installation_capacity_allocations(id) ON DELETE RESTRICT,
  installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('allocated','resized','suspended','reactivated','released')),
  generation BIGINT NOT NULL CHECK (generation>0),
  plan TEXT NOT NULL,
  allocation_memory_mb INTEGER NOT NULL CHECK (allocation_memory_mb>0),
  allocation_cpu_millis INTEGER NOT NULL CHECK (allocation_cpu_millis>0),
  allocation_storage_gb INTEGER NOT NULL CHECK (allocation_storage_gb>0),
  allocation_max_services INTEGER NOT NULL CHECK (allocation_max_services>0),
  source_hold_id UUID,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(allocation_id,generation,event_type)
);

CREATE FUNCTION managed_oss_protect_plan_capacity_hold()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF ROW(OLD.id,OLD.user_id,OLD.installation_id,OLD.allocation_id,OLD.idempotency_key,OLD.expected_generation,OLD.from_plan,OLD.requested_plan,OLD.worker_node_id,OLD.target_memory_mb,OLD.target_cpu_millis,OLD.target_storage_gb,OLD.target_max_services,OLD.reserved_delta_memory_mb,OLD.reserved_delta_cpu_millis,OLD.reserved_delta_storage_gb,OLD.infrastructure_monthly_cents,OLD.platform_fee_monthly_cents,OLD.provider_subscription_id,OLD.expires_at,OLD.created_at)
     IS DISTINCT FROM ROW(NEW.id,NEW.user_id,NEW.installation_id,NEW.allocation_id,NEW.idempotency_key,NEW.expected_generation,NEW.from_plan,NEW.requested_plan,NEW.worker_node_id,NEW.target_memory_mb,NEW.target_cpu_millis,NEW.target_storage_gb,NEW.target_max_services,NEW.reserved_delta_memory_mb,NEW.reserved_delta_cpu_millis,NEW.reserved_delta_storage_gb,NEW.infrastructure_monthly_cents,NEW.platform_fee_monthly_cents,NEW.provider_subscription_id,NEW.expires_at,NEW.created_at) THEN
    RAISE EXCEPTION 'plan capacity change hold snapshot is immutable';
  END IF;
  IF OLD.state<>'active' AND ROW(OLD.state,OLD.consumed_at,OLD.released_at,OLD.expired_at,OLD.release_reason)
     IS DISTINCT FROM ROW(NEW.state,NEW.consumed_at,NEW.released_at,NEW.expired_at,NEW.release_reason) THEN
    RAISE EXCEPTION 'terminal plan capacity change hold is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION managed_oss_reject_capacity_event_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'installation capacity allocation events are append-only';
END
$function$;

CREATE FUNCTION managed_oss_reject_checkout_plan_capacity_hold_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'checkout plan capacity hold allocation is immutable';
END
$function$;

CREATE TRIGGER plan_capacity_change_holds_immutable_snapshot
  BEFORE UPDATE ON plan_capacity_change_holds
  FOR EACH ROW EXECUTE FUNCTION managed_oss_protect_plan_capacity_hold();
CREATE TRIGGER installation_capacity_allocation_events_append_only
  BEFORE UPDATE OR DELETE ON installation_capacity_allocation_events
  FOR EACH ROW EXECUTE FUNCTION managed_oss_reject_capacity_event_change();
CREATE TRIGGER checkout_plan_capacity_holds_immutable
  BEFORE UPDATE OR DELETE ON checkout_plan_capacity_holds
  FOR EACH ROW EXECUTE FUNCTION managed_oss_reject_checkout_plan_capacity_hold_change();

ALTER TABLE checkout_plan_capacity_holds OWNER TO managed_oss_core_owner;
ALTER TABLE installation_capacity_allocations OWNER TO managed_oss_core_owner;
ALTER TABLE plan_capacity_change_holds OWNER TO managed_oss_core_owner;
ALTER TABLE installation_capacity_allocation_events OWNER TO managed_oss_core_owner;
ALTER FUNCTION managed_oss_protect_plan_capacity_hold() OWNER TO managed_oss_core_owner;
ALTER FUNCTION managed_oss_reject_capacity_event_change() OWNER TO managed_oss_core_owner;
ALTER FUNCTION managed_oss_reject_checkout_plan_capacity_hold_change() OWNER TO managed_oss_core_owner;
REVOKE ALL ON TABLE checkout_plan_capacity_holds,installation_capacity_allocations,plan_capacity_change_holds,installation_capacity_allocation_events FROM PUBLIC,managed_oss_runtime;
REVOKE ALL ON FUNCTION managed_oss_protect_plan_capacity_hold(),managed_oss_reject_capacity_event_change(),managed_oss_reject_checkout_plan_capacity_hold_change() FROM PUBLIC,managed_oss_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE checkout_plan_capacity_holds,installation_capacity_allocations,plan_capacity_change_holds TO managed_oss_control;
GRANT SELECT,INSERT ON TABLE installation_capacity_allocation_events TO managed_oss_control;
