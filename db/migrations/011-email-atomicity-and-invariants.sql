CREATE UNIQUE INDEX suite_email_command_receipt_key
  ON suite_records(workspace_id,module_id,(data->>'actionId'),(data->>'idempotencyKey'))
  WHERE module_id='email' AND record_type='email-command-receipt';

CREATE UNIQUE INDEX suite_email_subscriber_hash_key
  ON suite_records(workspace_id,module_id,(data->>'emailHash'))
  WHERE module_id='email' AND record_type='subscriber';

CREATE UNIQUE INDEX suite_email_provider_event_key
  ON suite_records(workspace_id,module_id,(data->>'eventId'))
  WHERE module_id='email' AND record_type='provider-receipt';

CREATE UNIQUE INDEX suite_email_consent_receipt_hash_key
  ON suite_records(workspace_id,module_id,(data->>'receiptHash'))
  WHERE module_id='email' AND record_type='consent-receipt';

CREATE OR REPLACE FUNCTION managed_oss_complete_suite_ai_action_v3(
  p_action_id UUID,
  p_status TEXT,
  p_result JSONB,
  p_last_error TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
DECLARE
  v_action public.suite_ai_actions%ROWTYPE;
  v_audit_id UUID;
  v_updated UUID;
BEGIN
  SELECT * INTO v_action
  FROM public.suite_ai_actions
  WHERE id=p_action_id AND status='running'
  FOR UPDATE;
  IF v_action.id IS NULL THEN RETURN FALSE; END IF;

  IF v_action.context->'resultContract'->>'version' IS DISTINCT FROM 'letterline-ai-result.v1' THEN
    RETURN public.managed_oss_complete_suite_ai_action_v2(p_action_id,p_status,p_result,p_last_error);
  END IF;

  IF p_status NOT IN ('completed','failed') OR p_result IS NULL OR pg_catalog.jsonb_typeof(p_result)<>'object' THEN
    RAISE EXCEPTION 'invalid AI completion input';
  END IF;
  IF COALESCE(v_action.context->>'aiAuditRecordId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION 'Letterline AI action has no valid audit record';
  END IF;
  v_audit_id := (v_action.context->>'aiAuditRecordId')::UUID;

  IF p_status='completed' THEN
    IF p_result->>'version' IS DISTINCT FROM 'letterline-ai-result.v1'
      OR EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_object_keys(p_result) AS result_key(key)
        WHERE key NOT IN ('version','proposals','confidence','assumptions','reviewStatus','approvalRequired','model')
      )
      OR pg_catalog.jsonb_typeof(p_result->'proposals') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(p_result->'proposals') NOT BETWEEN 1 AND 100
      OR pg_catalog.jsonb_typeof(v_action.context->'allowedProposalKinds') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_typeof(v_action.context->'evidenceIds') IS DISTINCT FROM 'array'
      OR COALESCE(v_action.context->>'targetRecordId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'Letterline AI completion violates its trusted result contract';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(p_result->'proposals') AS proposal_item(value)
      WHERE pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'object'
        OR EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_object_keys(value) AS proposal_key(key)
          WHERE key NOT IN ('proposalId','kind','content','citations','rationale','riskFlags')
        )
        OR COALESCE(value->>'proposalId','') !~ '^[A-Za-z0-9._:-]{1,100}$'
        OR pg_catalog.jsonb_typeof(value->'kind') IS DISTINCT FROM 'string'
        OR NOT ((v_action.context->'allowedProposalKinds') ? (value->>'kind'))
        OR pg_catalog.jsonb_typeof(value->'content') IS DISTINCT FROM 'string'
        OR pg_catalog.length(COALESCE(value->>'content','')) NOT BETWEEN 1 AND 100000
        OR (value->>'kind'='subject' AND (pg_catalog.length(value->>'content')>240 OR value->>'content' ~ '[\r\n]'))
        OR (value->>'kind'='body' AND pg_catalog.strpos(COALESCE(value->>'content',''),'{{unsubscribe_url}}')=0)
        OR pg_catalog.jsonb_typeof(value->'rationale') IS DISTINCT FROM 'string'
        OR pg_catalog.length(COALESCE(value->>'rationale','')) NOT BETWEEN 1 AND 4000
        OR pg_catalog.jsonb_typeof(value->'citations') IS DISTINCT FROM 'array'
        OR pg_catalog.jsonb_array_length(value->'citations') NOT BETWEEN 1 AND 100
        OR pg_catalog.jsonb_typeof(value->'riskFlags') IS DISTINCT FROM 'array'
        OR pg_catalog.jsonb_array_length(value->'riskFlags')>20
        OR EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_array_elements(value->'citations') AS citation_item(item)
          WHERE pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'string'
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_array_elements_text(value->'citations') AS citation_item(item)
          WHERE NOT ((v_action.context->'evidenceIds') ? item)
            AND item IS DISTINCT FROM v_action.context->>'targetRecordId'
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_array_elements(value->'riskFlags') AS risk_item(item)
          WHERE pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'string'
            OR pg_catalog.length(item#>>'{}') NOT BETWEEN 1 AND 500
        )
    ) THEN
      RAISE EXCEPTION 'Letterline AI completion violates its trusted result contract';
    END IF;

    IF (
      SELECT pg_catalog.count(*) IS DISTINCT FROM pg_catalog.count(DISTINCT value->>'proposalId')
      FROM pg_catalog.jsonb_array_elements(p_result->'proposals') AS proposal_item(value)
    ) THEN
      RAISE EXCEPTION 'Letterline AI completion violates its trusted result contract';
    END IF;

    IF pg_catalog.jsonb_typeof(p_result->'confidence') IS DISTINCT FROM 'number'
      OR (p_result->>'confidence')::NUMERIC<0
      OR (p_result->>'confidence')::NUMERIC>1
      OR pg_catalog.jsonb_typeof(p_result->'assumptions') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(p_result->'assumptions')>50
      OR EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(p_result->'assumptions') AS assumption_item(value)
        WHERE pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'string'
          OR pg_catalog.length(value#>>'{}') NOT BETWEEN 1 AND 1000
      )
      OR p_result->>'reviewStatus' IS DISTINCT FROM 'pending-human-review'
      OR p_result->'approvalRequired' IS DISTINCT FROM 'true'::JSONB
      OR pg_catalog.jsonb_typeof(p_result->'model') IS DISTINCT FROM 'string'
      OR pg_catalog.length(COALESCE(p_result->>'model','')) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'Letterline AI completion violates its trusted result contract';
    END IF;
  END IF;

  UPDATE public.suite_ai_actions
  SET status=p_status,result=p_result,last_error=p_last_error,lease_expires_at=NULL,updated_at=pg_catalog.now()
  WHERE id=v_action.id AND status='running';

  IF p_status='completed' THEN
    UPDATE public.suite_records
    SET state='pending-human-review',
        data=data||pg_catalog.jsonb_build_object(
          'aiActionId',v_action.id,
          'resultContractVersion','letterline-ai-result.v1',
          'executedModel',p_result->>'model',
          'confidence',p_result->'confidence',
          'proposalCount',pg_catalog.jsonb_array_length(p_result->'proposals'),
          'proposalIds',(
            SELECT pg_catalog.jsonb_agg(value->>'proposalId' ORDER BY value->>'proposalId')
            FROM pg_catalog.jsonb_array_elements(p_result->'proposals') AS proposal_item(value)
          ),
          'proposalKinds',(
            SELECT pg_catalog.jsonb_agg(kind ORDER BY kind)
            FROM (
              SELECT DISTINCT value->>'kind' AS kind
              FROM pg_catalog.jsonb_array_elements(p_result->'proposals') AS proposal_item(value)
            ) AS proposal_kinds
          ),
          'citedRecordIds',(
            SELECT pg_catalog.jsonb_agg(citation ORDER BY citation)
            FROM (
              SELECT DISTINCT citation_item.citation
              FROM pg_catalog.jsonb_array_elements(p_result->'proposals') AS proposal_item(value)
              CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(value->'citations') AS citation_item(citation)
            ) AS cited_records
          ),
          'assumptions',p_result->'assumptions',
          'reviewStatus','pending-human-review',
          'approvalRequired',TRUE,
          'automaticMutationAllowed',FALSE,
          'providerCallAllowed',FALSE,
          'externalEffectExecuted',FALSE,
          'completedAt',pg_catalog.now()
        ),
        updated_at=pg_catalog.now()
    WHERE id=v_audit_id
      AND workspace_id=v_action.workspace_id
      AND module_id='email'
      AND record_type='email-ai-request-audit'
      AND data->>'platformPromptDigest'=v_action.context->>'platformPromptDigest'
      AND data->>'targetRecordId'=v_action.context->>'targetRecordId'
      AND data->>'reviewStatus'='pending-model'
    RETURNING id INTO v_updated;
    IF v_updated IS NULL THEN RAISE EXCEPTION 'Letterline AI audit record is missing or stale'; END IF;
  ELSE
    UPDATE public.suite_records
    SET state='model-failed',
        data=data||pg_catalog.jsonb_build_object(
          'aiActionId',v_action.id,
          'reviewStatus','model-failed',
          'modelError',COALESCE(p_last_error,'Model execution failed.'),
          'automaticMutationAllowed',FALSE,
          'providerCallAllowed',FALSE,
          'externalEffectExecuted',FALSE,
          'failedAt',pg_catalog.now()
        ),
        updated_at=pg_catalog.now()
    WHERE id=v_audit_id
      AND workspace_id=v_action.workspace_id
      AND module_id='email'
      AND record_type='email-ai-request-audit'
      AND data->>'platformPromptDigest'=v_action.context->>'platformPromptDigest'
      AND data->>'reviewStatus'='pending-model'
    RETURNING id INTO v_updated;
    IF v_updated IS NULL THEN RAISE EXCEPTION 'Letterline AI audit record is missing or stale'; END IF;
  END IF;

  PERFORM pg_catalog.set_config('app.workspace_id',v_action.workspace_id::TEXT,TRUE);
  RETURN TRUE;
END
$function$;

ALTER FUNCTION managed_oss_complete_suite_ai_action_v3(UUID,TEXT,JSONB,TEXT) OWNER TO managed_oss_suite_owner;
REVOKE ALL ON FUNCTION managed_oss_complete_suite_ai_action_v3(UUID,TEXT,JSONB,TEXT) FROM PUBLIC,managed_oss_runtime;
GRANT EXECUTE ON FUNCTION managed_oss_complete_suite_ai_action_v3(UUID,TEXT,JSONB,TEXT) TO managed_oss_ai;
