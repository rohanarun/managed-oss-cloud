CREATE OR REPLACE FUNCTION managed_oss_public_workspace_context_by_id(p_workspace_id UUID,p_unrestricted BOOLEAN)
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
  WHERE w.id=p_workspace_id AND (p_unrestricted OR w.plan<>'none');
  IF v_workspace_id IS NULL THEN RETURN; END IF;
  PERFORM pg_catalog.set_config('app.workspace_id',v_workspace_id::TEXT,TRUE);
  RETURN QUERY SELECT v_workspace_id;
END
$function$;

ALTER FUNCTION managed_oss_public_workspace_context_by_id(UUID,BOOLEAN) OWNER TO managed_oss_suite_owner;
REVOKE ALL ON FUNCTION managed_oss_public_workspace_context_by_id(UUID,BOOLEAN) FROM PUBLIC,managed_oss_ai;
GRANT EXECUTE ON FUNCTION managed_oss_public_workspace_context_by_id(UUID,BOOLEAN) TO managed_oss_runtime;

CREATE UNIQUE INDEX suite_growth_active_entry_participant_idx
  ON suite_records(workspace_id,(data->>'contestId'),(data->>'participantKeyHash'))
  WHERE module_id='giveaways'
    AND record_type='entrant'
    AND state<>'revoked'
    AND data ? 'contestId'
    AND data ? 'participantKeyHash';

CREATE UNIQUE INDEX suite_growth_active_testimonial_source_idx
  ON suite_records(workspace_id,(data->>'sourceRefHash'))
  WHERE module_id='testimonials'
    AND record_type='testimonial'
    AND state<>'revoked'
    AND data ? 'sourceRefHash';

CREATE UNIQUE INDEX suite_growth_live_page_slug_idx
  ON suite_records(workspace_id,(data->>'slug'))
  WHERE module_id='brand-pages'
    AND record_type='page'
    AND state<>'disabled'
    AND data ? 'slug';

CREATE UNIQUE INDEX suite_growth_live_qr_slug_idx
  ON suite_records(workspace_id,(data->>'slug'))
  WHERE module_id='brand-pages'
    AND record_type='qr-route'
    AND state<>'disabled'
    AND data ? 'slug';

CREATE UNIQUE INDEX suite_growth_collection_request_token_idx
  ON suite_records(workspace_id,(data->>'accessTokenHash'))
  WHERE module_id='testimonials'
    AND record_type='collection-request'
    AND data ? 'accessTokenHash';
