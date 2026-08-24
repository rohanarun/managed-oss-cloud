DO $block$
DECLARE
  v_conflicts BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_conflicts
  FROM public.suite_records
  WHERE record_type IN (
    'command-receipt','premium-command-receipt','growth-command-receipt',
    'esign-command-receipt','email-command-receipt','additive-command-receipt',
    'extended-business-command-receipt'
  )
    AND data ? 'approvalDecisionId'
    AND data->>'approvalDecisionId' IS NOT NULL
    AND COALESCE(
      data#>>'{audit,approvalDecisionId}',
      data#>>'{audit,approval,decisionId}',
      data#>>'{result,audit,approvalDecisionId}',
      data#>>'{resultSnapshot,audit,approvalDecisionId}'
    ) IS NOT NULL
    AND data->>'approvalDecisionId'<>COALESCE(
      data#>>'{audit,approvalDecisionId}',
      data#>>'{audit,approval,decisionId}',
      data#>>'{result,audit,approvalDecisionId}',
      data#>>'{resultSnapshot,audit,approvalDecisionId}'
    );
  IF v_conflicts>0 THEN
    RAISE EXCEPTION 'Command receipt approval attribution is inconsistent.';
  END IF;
END
$block$;

UPDATE public.suite_records
SET data=data||pg_catalog.jsonb_build_object(
  'approvalDecisionId',
  COALESCE(
    data#>>'{audit,approvalDecisionId}',
    data#>>'{audit,approval,decisionId}',
    data#>>'{result,audit,approvalDecisionId}',
    data#>>'{resultSnapshot,audit,approvalDecisionId}'
  )
)
WHERE record_type IN (
  'command-receipt','premium-command-receipt','growth-command-receipt',
  'esign-command-receipt','email-command-receipt','additive-command-receipt',
  'extended-business-command-receipt'
)
  AND (NOT data ? 'approvalDecisionId' OR data->>'approvalDecisionId' IS NULL)
  AND COALESCE(
    data#>>'{audit,approvalDecisionId}',
    data#>>'{audit,approval,decisionId}',
    data#>>'{result,audit,approvalDecisionId}',
    data#>>'{resultSnapshot,audit,approvalDecisionId}'
  ) IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS suite_records_command_idempotency_unique
ON public.suite_records(workspace_id,record_type,module_id,(data->>'actionId'),(data->>'idempotencyKey'))
WHERE record_type IN (
  'command-receipt','premium-command-receipt','growth-command-receipt',
  'esign-command-receipt','email-command-receipt','additive-command-receipt',
  'extended-business-command-receipt'
)
  AND data->>'actionId' IS NOT NULL
  AND data->>'idempotencyKey' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS suite_records_approval_decision_unique
ON public.suite_records(workspace_id,(data->>'approvalDecisionId'))
WHERE record_type IN (
  'command-receipt','premium-command-receipt','growth-command-receipt',
  'esign-command-receipt','email-command-receipt','additive-command-receipt',
  'extended-business-command-receipt'
)
  AND data->>'approvalDecisionId' IS NOT NULL;

CREATE OR REPLACE FUNCTION managed_oss_ai_action_requester_principal(p_action_id UUID)
RETURNS TABLE(requested_by_user_id UUID,requested_by_role TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
  SELECT member.user_id,member.role
  FROM public.suite_ai_actions action
  JOIN public.suite_workspace_members member
    ON member.workspace_id=action.workspace_id
   AND member.user_id::TEXT=action.context->>'requestedByUserId'
  WHERE action.id=p_action_id
    AND action.status='running'
    AND action.workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID
  LIMIT 1
$function$;

ALTER FUNCTION managed_oss_ai_action_requester_principal(UUID) OWNER TO managed_oss_suite_owner;
REVOKE ALL ON FUNCTION managed_oss_ai_action_requester_principal(UUID) FROM PUBLIC,managed_oss_runtime,managed_oss_control,managed_oss_migrator;
GRANT EXECUTE ON FUNCTION managed_oss_ai_action_requester_principal(UUID) TO managed_oss_ai;
