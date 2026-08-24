DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_suite_owner') THEN
    CREATE ROLE managed_oss_suite_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_runtime') THEN
    CREATE ROLE managed_oss_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_ai') THEN
    CREATE ROLE managed_oss_ai NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='managed_oss_migrator') THEN
    CREATE ROLE managed_oss_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$roles$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO managed_oss_runtime,managed_oss_ai,managed_oss_migrator;
GRANT CREATE ON SCHEMA public TO managed_oss_migrator;
GRANT managed_oss_suite_owner TO managed_oss_migrator;
GRANT SELECT ON TABLE users TO managed_oss_suite_owner;

ALTER TABLE suite_workspaces OWNER TO managed_oss_suite_owner;
ALTER TABLE suite_workspace_members OWNER TO managed_oss_suite_owner;
ALTER TABLE suite_custom_domains OWNER TO managed_oss_suite_owner;
ALTER TABLE suite_workspace_modules OWNER TO managed_oss_suite_owner;
ALTER TABLE suite_records OWNER TO managed_oss_suite_owner;
ALTER TABLE suite_events OWNER TO managed_oss_suite_owner;
ALTER TABLE suite_ai_actions OWNER TO managed_oss_suite_owner;
ALTER TABLE suite_api_tokens OWNER TO managed_oss_suite_owner;
ALTER TABLE suite_record_links OWNER TO managed_oss_suite_owner;
ALTER TABLE managed_schema_migrations OWNER TO managed_oss_suite_owner;

ALTER TABLE suite_api_tokens ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE suite_api_tokens t
SET workspace_id=m.workspace_id
FROM suite_workspace_members m
WHERE m.user_id=t.user_id AND t.workspace_id IS NULL;
DO $tokens$
BEGIN
  IF EXISTS (SELECT 1 FROM suite_api_tokens WHERE workspace_id IS NULL) THEN
    RAISE EXCEPTION 'suite_api_tokens contains rows without a workspace membership';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='suite_api_tokens_workspace_id_fkey') THEN
    ALTER TABLE suite_api_tokens
      ADD CONSTRAINT suite_api_tokens_workspace_id_fkey
      FOREIGN KEY(workspace_id) REFERENCES suite_workspaces(id) ON DELETE CASCADE;
  END IF;
END
$tokens$;
ALTER TABLE suite_api_tokens ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS suite_api_tokens_workspace_idx ON suite_api_tokens(workspace_id,created_at DESC);

CREATE OR REPLACE FUNCTION managed_oss_workspace_context_for_user(p_user_id UUID,p_default_plan TEXT)
RETURNS TABLE(workspace_id UUID,member_role TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
DECLARE
  v_workspace_id UUID;
  v_role TEXT;
BEGIN
  IF p_default_plan NOT IN ('none','starter','scale','fleet') THEN
    RAISE EXCEPTION 'invalid default suite plan';
  END IF;
  SELECT m.workspace_id,m.role INTO v_workspace_id,v_role
  FROM public.suite_workspace_members m
  WHERE m.user_id=p_user_id;

  IF v_workspace_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id=p_user_id) THEN
      RETURN;
    END IF;
    INSERT INTO public.suite_workspaces(id,user_id,name,slug,plan)
    VALUES(
      pg_catalog.gen_random_uuid(),
      p_user_id,
      'My workspace',
      'workspace-' || pg_catalog.substr(pg_catalog.replace(p_user_id::TEXT,'-',''),1,12),
      p_default_plan
    )
    ON CONFLICT(user_id) DO UPDATE SET updated_at=public.suite_workspaces.updated_at
    RETURNING id INTO v_workspace_id;
    INSERT INTO public.suite_workspace_members(workspace_id,user_id,role)
    VALUES(v_workspace_id,p_user_id,'owner')
    ON CONFLICT(user_id) DO NOTHING;
    SELECT m.workspace_id,m.role INTO v_workspace_id,v_role
    FROM public.suite_workspace_members m
    WHERE m.user_id=p_user_id;
  END IF;

  IF v_workspace_id IS NULL OR v_role IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.workspace_id',v_workspace_id::TEXT,TRUE);
  RETURN QUERY SELECT v_workspace_id,v_role;
END
$function$;

CREATE OR REPLACE FUNCTION managed_oss_public_workspace_context(p_slug TEXT,p_unrestricted BOOLEAN)
RETURNS TABLE(workspace_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
DECLARE
  v_workspace_id UUID;
BEGIN
  SELECT w.id INTO v_workspace_id
  FROM public.suite_workspaces w
  WHERE w.slug=p_slug AND (p_unrestricted OR w.plan<>'none');
  IF v_workspace_id IS NULL THEN RETURN; END IF;
  PERFORM pg_catalog.set_config('app.workspace_id',v_workspace_id::TEXT,TRUE);
  RETURN QUERY SELECT v_workspace_id;
END
$function$;

CREATE OR REPLACE FUNCTION managed_oss_custom_domain_workspace_context(p_domain TEXT,p_unrestricted BOOLEAN)
RETURNS TABLE(workspace_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
DECLARE
  v_workspace_id UUID;
BEGIN
  SELECT d.workspace_id INTO v_workspace_id
  FROM public.suite_custom_domains d
  JOIN public.suite_workspaces w ON w.id=d.workspace_id
  WHERE d.domain=p_domain
    AND d.status IN ('verified','active')
    AND (p_unrestricted OR w.plan<>'none');
  IF v_workspace_id IS NULL THEN RETURN; END IF;
  PERFORM pg_catalog.set_config('app.workspace_id',v_workspace_id::TEXT,TRUE);
  RETURN QUERY SELECT v_workspace_id;
END
$function$;

CREATE OR REPLACE FUNCTION managed_oss_list_active_suite_domains(p_unrestricted BOOLEAN)
RETURNS TABLE(domain TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
  SELECT d.domain
  FROM public.suite_custom_domains d
  JOIN public.suite_workspaces w ON w.id=d.workspace_id
  WHERE d.status IN ('verified','active') AND (p_unrestricted OR w.plan<>'none')
  ORDER BY d.domain
$function$;

CREATE OR REPLACE FUNCTION managed_oss_api_token_principal(p_token_hash TEXT)
RETURNS TABLE(token_id UUID,user_id UUID,workspace_id UUID,scopes TEXT[])
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
  UPDATE public.suite_api_tokens t
  SET last_used_at=pg_catalog.now()
  FROM public.suite_workspace_members m
  WHERE t.token_hash=p_token_hash
    AND t.revoked_at IS NULL
    AND t.expires_at>pg_catalog.now()
    AND m.user_id=t.user_id
    AND m.workspace_id=t.workspace_id
  RETURNING t.id,t.user_id,t.workspace_id,t.scopes
$function$;

CREATE OR REPLACE FUNCTION managed_oss_claim_suite_ai_action(
  p_unrestricted BOOLEAN,
  p_scale_modules TEXT[],
  p_starter_modules TEXT[]
)
RETURNS SETOF public.suite_ai_actions
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
DECLARE
  v_action public.suite_ai_actions%ROWTYPE;
BEGIN
  UPDATE public.suite_ai_actions a
  SET status='failed',
      result=pg_catalog.jsonb_build_object('error','The workspace plan changed before this AI action ran.','retryable',FALSE),
      last_error='Workspace entitlement revoked.',
      lease_expires_at=NULL,
      updated_at=pg_catalog.now()
  FROM public.suite_workspaces w
  WHERE a.workspace_id=w.id
    AND a.status IN ('queued','running')
    AND NOT (p_unrestricted OR w.plan='fleet' OR (w.plan='scale' AND a.module_id=ANY(p_scale_modules)) OR (w.plan='starter' AND a.module_id=ANY(p_starter_modules)));

  UPDATE public.suite_ai_actions
  SET status='failed',
      result=pg_catalog.jsonb_build_object('error','The AI action exhausted its retry limit after its worker lease expired.','retryable',FALSE),
      last_error='The AI action exhausted its retry limit after its worker lease expired.',
      lease_expires_at=NULL,
      updated_at=pg_catalog.now()
  WHERE status='running' AND lease_expires_at<pg_catalog.now() AND attempts>=3;

  UPDATE public.suite_ai_actions a
  SET status='running',attempts=a.attempts+1,lease_expires_at=pg_catalog.now()+INTERVAL '5 minutes',updated_at=pg_catalog.now()
  WHERE a.id=(
    SELECT candidate.id
    FROM public.suite_ai_actions candidate
    JOIN public.suite_workspaces w ON w.id=candidate.workspace_id
    WHERE (candidate.status='queued' OR (candidate.status='running' AND candidate.lease_expires_at<pg_catalog.now()))
      AND candidate.attempts<3
      AND (p_unrestricted OR w.plan='fleet' OR (w.plan='scale' AND candidate.module_id=ANY(p_scale_modules)) OR (w.plan='starter' AND candidate.module_id=ANY(p_starter_modules)))
    ORDER BY candidate.created_at
    FOR UPDATE OF candidate SKIP LOCKED
    LIMIT 1
  )
  RETURNING a.* INTO v_action;

  IF v_action.id IS NULL THEN RETURN; END IF;
  PERFORM pg_catalog.set_config('app.workspace_id',v_action.workspace_id::TEXT,TRUE);
  RETURN NEXT v_action;
END
$function$;

CREATE OR REPLACE FUNCTION managed_oss_complete_suite_ai_action(p_action_id UUID,p_status TEXT,p_result JSONB,p_last_error TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
DECLARE
  v_workspace_id UUID;
BEGIN
  IF p_status NOT IN ('completed','failed') THEN
    RAISE EXCEPTION 'invalid AI completion status';
  END IF;
  UPDATE public.suite_ai_actions
  SET status=p_status,result=p_result,last_error=p_last_error,lease_expires_at=NULL,updated_at=pg_catalog.now()
  WHERE id=p_action_id AND status='running'
  RETURNING workspace_id INTO v_workspace_id;
  IF v_workspace_id IS NULL THEN RETURN FALSE; END IF;
  PERFORM pg_catalog.set_config('app.workspace_id',v_workspace_id::TEXT,TRUE);
  RETURN TRUE;
END
$function$;

ALTER FUNCTION managed_oss_workspace_context_for_user(UUID,TEXT) OWNER TO managed_oss_suite_owner;
ALTER FUNCTION managed_oss_public_workspace_context(TEXT,BOOLEAN) OWNER TO managed_oss_suite_owner;
ALTER FUNCTION managed_oss_custom_domain_workspace_context(TEXT,BOOLEAN) OWNER TO managed_oss_suite_owner;
ALTER FUNCTION managed_oss_list_active_suite_domains(BOOLEAN) OWNER TO managed_oss_suite_owner;
ALTER FUNCTION managed_oss_api_token_principal(TEXT) OWNER TO managed_oss_suite_owner;
ALTER FUNCTION managed_oss_claim_suite_ai_action(BOOLEAN,TEXT[],TEXT[]) OWNER TO managed_oss_suite_owner;
ALTER FUNCTION managed_oss_complete_suite_ai_action(UUID,TEXT,JSONB,TEXT) OWNER TO managed_oss_suite_owner;

REVOKE ALL ON TABLE suite_workspaces,suite_workspace_members,suite_custom_domains,suite_workspace_modules,suite_records,suite_events,suite_ai_actions,suite_api_tokens,suite_record_links,managed_schema_migrations FROM PUBLIC;
REVOKE ALL ON FUNCTION managed_oss_workspace_context_for_user(UUID,TEXT),managed_oss_public_workspace_context(TEXT,BOOLEAN),managed_oss_custom_domain_workspace_context(TEXT,BOOLEAN),managed_oss_list_active_suite_domains(BOOLEAN),managed_oss_api_token_principal(TEXT),managed_oss_claim_suite_ai_action(BOOLEAN,TEXT[],TEXT[]),managed_oss_complete_suite_ai_action(UUID,TEXT,JSONB,TEXT) FROM PUBLIC;

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE suite_workspaces,suite_workspace_members,suite_custom_domains,suite_workspace_modules,suite_records,suite_events,suite_ai_actions,suite_api_tokens,suite_record_links TO managed_oss_runtime;
GRANT SELECT ON TABLE suite_records TO managed_oss_ai;
GRANT EXECUTE ON FUNCTION managed_oss_workspace_context_for_user(UUID,TEXT),managed_oss_public_workspace_context(TEXT,BOOLEAN),managed_oss_custom_domain_workspace_context(TEXT,BOOLEAN),managed_oss_list_active_suite_domains(BOOLEAN),managed_oss_api_token_principal(TEXT) TO managed_oss_runtime;
GRANT EXECUTE ON FUNCTION managed_oss_claim_suite_ai_action(BOOLEAN,TEXT[],TEXT[]),managed_oss_complete_suite_ai_action(UUID,TEXT,JSONB,TEXT) TO managed_oss_ai;
GRANT SELECT ON TABLE managed_schema_migrations TO managed_oss_runtime,managed_oss_ai;

ALTER DEFAULT PRIVILEGES FOR ROLE managed_oss_suite_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE managed_oss_suite_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Phase A deliberately stops before enabling row-level security or creating policies.
