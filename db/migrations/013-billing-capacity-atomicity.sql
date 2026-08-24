-- Signed payment evidence must remain recoverable even when webhook delivery
-- arrives after the temporary checkout reservation. The recovery record is a
-- durable local obligation: either capacity is atomically placed or operations
-- must cancel the provider subscription and refund the captured payment before
-- marking the obligation compensated.

CREATE TABLE paid_checkout_capacity_recoveries (
  id UUID PRIMARY KEY,
  stripe_event_id TEXT NOT NULL UNIQUE REFERENCES stripe_events(event_id) ON DELETE RESTRICT,
  checkout_hold_id UUID NOT NULL UNIQUE REFERENCES checkout_capacity_holds(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE RESTRICT,
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT NOT NULL,
  provider_subscription_id TEXT NOT NULL UNIQUE,
  infrastructure_monthly_cents INTEGER NOT NULL CHECK (infrastructure_monthly_cents>0),
  platform_fee_monthly_cents INTEGER NOT NULL CHECK (platform_fee_monthly_cents>0),
  state TEXT NOT NULL DEFAULT 'pending_capacity' CHECK (state IN ('pending_capacity','fulfilled','compensation_required','compensated')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  compensation_deadline_at TIMESTAMPTZ NOT NULL,
  compensation_action TEXT NOT NULL DEFAULT 'cancel_subscription_and_refund_captured_payment'
    CHECK (compensation_action='cancel_subscription_and_refund_captured_payment'),
  last_attempt_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ,
  compensation_required_at TIMESTAMPTZ,
  compensated_at TIMESTAMPTZ,
  compensation_reference TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT paid_checkout_capacity_recovery_deadline_check CHECK (compensation_deadline_at>created_at),
  CONSTRAINT paid_checkout_capacity_recovery_state_check CHECK (
    (state='pending_capacity' AND fulfilled_at IS NULL AND compensation_required_at IS NULL AND compensated_at IS NULL AND compensation_reference IS NULL)
    OR (state='fulfilled' AND fulfilled_at IS NOT NULL AND compensation_required_at IS NULL AND compensated_at IS NULL AND compensation_reference IS NULL)
    OR (state='compensation_required' AND fulfilled_at IS NULL AND compensation_required_at IS NOT NULL AND compensated_at IS NULL AND compensation_reference IS NULL)
    OR (state='compensated' AND fulfilled_at IS NULL AND compensation_required_at IS NOT NULL AND compensated_at IS NOT NULL AND compensation_reference IS NOT NULL)
  )
);

CREATE INDEX paid_checkout_capacity_recoveries_work_idx
  ON paid_checkout_capacity_recoveries(state,compensation_deadline_at,created_at);

CREATE UNIQUE INDEX paid_checkout_capacity_recoveries_active_installation_idx
  ON paid_checkout_capacity_recoveries(installation_id)
  WHERE state IN ('pending_capacity','compensation_required');

COMMENT ON TABLE paid_checkout_capacity_recoveries IS
  'Durable paid-but-unplaced checkout obligations. Pending rows are retried only after exact provider confirmation; compensation-required rows mandate provider cancellation and a captured-payment refund.';

-- A provider update can succeed while its response, signed webhook, or
-- reconciler races the local commit. Preserve exact provider confirmation on
-- the resize hold, and permit an expired hold to converge to consumed only
-- after that confirmation is supplied by a trusted billing path.
ALTER TABLE plan_capacity_change_holds
  ADD COLUMN provider_committed_at TIMESTAMPTZ,
  ADD COLUMN provider_confirmation_source TEXT;

UPDATE plan_capacity_change_holds
SET provider_committed_at=consumed_at,
    provider_confirmation_source='legacy_provider_update_response'
WHERE state='consumed';

ALTER TABLE plan_capacity_change_holds
  DROP CONSTRAINT plan_capacity_change_hold_state_check;

ALTER TABLE plan_capacity_change_holds
  ADD CONSTRAINT plan_capacity_change_hold_state_check CHECK (
    (state='active' AND consumed_at IS NULL AND released_at IS NULL AND expired_at IS NULL AND release_reason IS NULL AND provider_committed_at IS NULL AND provider_confirmation_source IS NULL)
    OR (state='consumed' AND consumed_at IS NOT NULL AND released_at IS NULL AND provider_committed_at IS NOT NULL AND length(provider_confirmation_source)>0)
    OR (state='released' AND consumed_at IS NULL AND released_at IS NOT NULL AND expired_at IS NULL AND release_reason IS NOT NULL AND provider_committed_at IS NULL AND provider_confirmation_source IS NULL)
    OR (state='expired' AND consumed_at IS NULL AND released_at IS NULL AND expired_at IS NOT NULL AND provider_committed_at IS NULL AND provider_confirmation_source IS NULL)
  );

CREATE OR REPLACE FUNCTION managed_oss_protect_plan_capacity_hold()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF ROW(OLD.id,OLD.user_id,OLD.installation_id,OLD.allocation_id,OLD.idempotency_key,OLD.expected_generation,OLD.from_plan,OLD.requested_plan,OLD.worker_node_id,OLD.target_memory_mb,OLD.target_cpu_millis,OLD.target_storage_gb,OLD.target_max_services,OLD.reserved_delta_memory_mb,OLD.reserved_delta_cpu_millis,OLD.reserved_delta_storage_gb,OLD.infrastructure_monthly_cents,OLD.platform_fee_monthly_cents,OLD.provider_subscription_id,OLD.expires_at,OLD.created_at)
     IS DISTINCT FROM ROW(NEW.id,NEW.user_id,NEW.installation_id,NEW.allocation_id,NEW.idempotency_key,NEW.expected_generation,NEW.from_plan,NEW.requested_plan,NEW.worker_node_id,NEW.target_memory_mb,NEW.target_cpu_millis,NEW.target_storage_gb,NEW.target_max_services,NEW.reserved_delta_memory_mb,NEW.reserved_delta_cpu_millis,NEW.reserved_delta_storage_gb,NEW.infrastructure_monthly_cents,NEW.platform_fee_monthly_cents,NEW.provider_subscription_id,NEW.expires_at,NEW.created_at) THEN
    RAISE EXCEPTION 'plan capacity change hold snapshot is immutable';
  END IF;
  IF OLD.state IN ('consumed','released') AND ROW(OLD.state,OLD.consumed_at,OLD.released_at,OLD.expired_at,OLD.release_reason,OLD.provider_committed_at,OLD.provider_confirmation_source)
     IS DISTINCT FROM ROW(NEW.state,NEW.consumed_at,NEW.released_at,NEW.expired_at,NEW.release_reason,NEW.provider_committed_at,NEW.provider_confirmation_source) THEN
    RAISE EXCEPTION 'terminal plan capacity change hold is immutable';
  END IF;
  IF OLD.state='expired' AND NOT (
    NEW.state='expired'
    OR (
      NEW.state='consumed'
      AND NEW.consumed_at IS NOT NULL
      AND NEW.provider_committed_at IS NOT NULL
      AND length(NEW.provider_confirmation_source)>0
      AND NEW.released_at IS NOT DISTINCT FROM OLD.released_at
      AND NEW.expired_at IS NOT DISTINCT FROM OLD.expired_at
      AND NEW.release_reason IS NOT DISTINCT FROM OLD.release_reason
    )
  ) THEN
    RAISE EXCEPTION 'expired plan capacity change hold requires exact provider confirmation';
  END IF;
  RETURN NEW;
END
$function$;

ALTER TABLE paid_checkout_capacity_recoveries OWNER TO managed_oss_core_owner;
REVOKE ALL ON TABLE paid_checkout_capacity_recoveries FROM PUBLIC,managed_oss_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE paid_checkout_capacity_recoveries TO managed_oss_control;
