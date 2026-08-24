DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_core_owner') THEN
    CREATE ROLE managed_oss_core_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_control') THEN
    CREATE ROLE managed_oss_control NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$roles$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO managed_oss_control;
GRANT managed_oss_core_owner TO managed_oss_migrator;

ALTER TABLE users OWNER TO managed_oss_core_owner;
ALTER TABLE sessions OWNER TO managed_oss_core_owner;
ALTER TABLE billing_accounts OWNER TO managed_oss_core_owner;
ALTER TABLE subscriptions OWNER TO managed_oss_core_owner;
ALTER TABLE installations OWNER TO managed_oss_core_owner;
ALTER TABLE worker_nodes OWNER TO managed_oss_core_owner;
ALTER TABLE application_instances OWNER TO managed_oss_core_owner;
ALTER TABLE custom_domains OWNER TO managed_oss_core_owner;
ALTER TABLE billing_ledger OWNER TO managed_oss_core_owner;
ALTER TABLE idempotency_keys OWNER TO managed_oss_core_owner;
ALTER TABLE provisioning_jobs OWNER TO managed_oss_core_owner;
ALTER TABLE stripe_events OWNER TO managed_oss_core_owner;
ALTER TABLE backups OWNER TO managed_oss_core_owner;
ALTER TABLE checkout_capacity_holds OWNER TO managed_oss_core_owner;
ALTER TABLE checkout_capacity_hold_items OWNER TO managed_oss_core_owner;

REVOKE ALL ON TABLE users,sessions,billing_accounts,subscriptions,installations,worker_nodes,application_instances,custom_domains,billing_ledger,idempotency_keys,provisioning_jobs,stripe_events,backups,checkout_capacity_holds,checkout_capacity_hold_items FROM PUBLIC;
REVOKE ALL ON TABLE checkout_capacity_holds,checkout_capacity_hold_items FROM managed_oss_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE users,sessions,billing_accounts,subscriptions,installations,worker_nodes,application_instances,custom_domains,billing_ledger,idempotency_keys,provisioning_jobs,stripe_events,backups,checkout_capacity_holds,checkout_capacity_hold_items TO managed_oss_control;
GRANT SELECT,INSERT ON TABLE global_hostname_claims TO managed_oss_control;
GRANT UPDATE(status,last_checked_at,verified_at,tombstoned_at) ON TABLE global_hostname_claims TO managed_oss_control;
GRANT SELECT ON TABLE managed_schema_migrations TO managed_oss_control;

CREATE OR REPLACE FUNCTION managed_oss_reconcile_suite_entitlement(
  p_user_id UUID,
  p_plan TEXT,
  p_allowed_modules TEXT[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
DECLARE
  v_workspace_id UUID;
BEGIN
  IF p_plan NOT IN ('none','starter','scale','fleet') OR p_allowed_modules IS NULL OR pg_catalog.array_position(p_allowed_modules,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid suite entitlement reconciliation input';
  END IF;
  UPDATE public.suite_workspaces
  SET plan=p_plan,updated_at=pg_catalog.now()
  WHERE user_id=p_user_id AND plan<>p_plan
  RETURNING id INTO v_workspace_id;
  IF v_workspace_id IS NULL THEN
    SELECT id INTO v_workspace_id FROM public.suite_workspaces WHERE user_id=p_user_id;
  END IF;
  IF v_workspace_id IS NULL THEN RETURN FALSE; END IF;
  UPDATE public.suite_ai_actions
  SET status='failed',
      result=pg_catalog.jsonb_build_object('error','The workspace plan changed before this AI action ran.','retryable',FALSE),
      last_error='Workspace entitlement revoked.',
      lease_expires_at=NULL,
      updated_at=pg_catalog.now()
  WHERE workspace_id=v_workspace_id
    AND status IN ('queued','running')
    AND NOT (module_id=ANY(p_allowed_modules));
  RETURN TRUE;
END
$function$;

ALTER FUNCTION managed_oss_reconcile_suite_entitlement(UUID,TEXT,TEXT[]) OWNER TO managed_oss_suite_owner;
REVOKE ALL ON FUNCTION managed_oss_reconcile_suite_entitlement(UUID,TEXT,TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION managed_oss_reconcile_suite_entitlement(UUID,TEXT,TEXT[]) TO managed_oss_control;

CREATE POLICY suite_workspaces_tenant ON suite_workspaces
  FOR ALL TO managed_oss_runtime,managed_oss_ai,managed_oss_suite_owner,managed_oss_migrator
  USING (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID)
  WITH CHECK (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID);
CREATE POLICY suite_workspace_members_tenant ON suite_workspace_members
  FOR ALL TO managed_oss_runtime,managed_oss_ai,managed_oss_suite_owner,managed_oss_migrator
  USING (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID)
  WITH CHECK (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID);
CREATE POLICY suite_custom_domains_tenant ON suite_custom_domains
  FOR ALL TO managed_oss_runtime,managed_oss_ai,managed_oss_suite_owner,managed_oss_migrator
  USING (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID)
  WITH CHECK (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID);
CREATE POLICY suite_workspace_modules_tenant ON suite_workspace_modules
  FOR ALL TO managed_oss_runtime,managed_oss_ai,managed_oss_suite_owner,managed_oss_migrator
  USING (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID)
  WITH CHECK (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID);
CREATE POLICY suite_records_tenant ON suite_records
  FOR ALL TO managed_oss_runtime,managed_oss_ai,managed_oss_suite_owner,managed_oss_migrator
  USING (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID)
  WITH CHECK (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID);
CREATE POLICY suite_events_tenant ON suite_events
  FOR ALL TO managed_oss_runtime,managed_oss_ai,managed_oss_suite_owner,managed_oss_migrator
  USING (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID)
  WITH CHECK (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID);
CREATE POLICY suite_ai_actions_tenant ON suite_ai_actions
  FOR ALL TO managed_oss_runtime,managed_oss_ai,managed_oss_suite_owner,managed_oss_migrator
  USING (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID)
  WITH CHECK (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID);
CREATE POLICY suite_api_tokens_tenant ON suite_api_tokens
  FOR ALL TO managed_oss_runtime,managed_oss_ai,managed_oss_suite_owner,managed_oss_migrator
  USING (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID)
  WITH CHECK (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID);
CREATE POLICY suite_record_links_tenant ON suite_record_links
  FOR ALL TO managed_oss_runtime,managed_oss_ai,managed_oss_suite_owner,managed_oss_migrator
  USING (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID)
  WITH CHECK (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member') OR workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID);

CREATE POLICY global_hostname_claims_owner ON global_hostname_claims
  FOR ALL TO managed_oss_suite_owner,managed_oss_migrator
  USING (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member'))
  WITH CHECK (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member'));
CREATE POLICY global_hostname_claims_control ON global_hostname_claims
  FOR ALL TO managed_oss_control
  USING (TRUE)
  WITH CHECK (surface='application');
CREATE POLICY global_hostname_claims_suite ON global_hostname_claims
  FOR ALL TO managed_oss_runtime
  USING (surface='suite' AND resource_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID)
  WITH CHECK (surface='suite' AND resource_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID);

ALTER TABLE suite_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE suite_workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE suite_workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE suite_workspace_members FORCE ROW LEVEL SECURITY;
ALTER TABLE suite_custom_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE suite_custom_domains FORCE ROW LEVEL SECURITY;
ALTER TABLE suite_workspace_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE suite_workspace_modules FORCE ROW LEVEL SECURITY;
ALTER TABLE suite_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE suite_records FORCE ROW LEVEL SECURITY;
ALTER TABLE suite_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE suite_events FORCE ROW LEVEL SECURITY;
ALTER TABLE suite_ai_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE suite_ai_actions FORCE ROW LEVEL SECURITY;
ALTER TABLE suite_api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE suite_api_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE suite_record_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE suite_record_links FORCE ROW LEVEL SECURITY;
ALTER TABLE global_hostname_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_hostname_claims FORCE ROW LEVEL SECURITY;

ALTER DEFAULT PRIVILEGES FOR ROLE managed_oss_core_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE managed_oss_core_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
