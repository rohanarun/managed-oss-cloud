CREATE UNIQUE INDEX suite_action_receipt_idempotency_idx
  ON suite_records(workspace_id,module_id,(data->>'actionId'),(data->>'idempotencyKey'))
  WHERE record_type IN ('command-receipt','premium-command-receipt','growth-command-receipt')
    AND data ? 'idempotencyKey';

CREATE OR REPLACE FUNCTION managed_oss_complete_suite_ai_action(
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
  IF p_status NOT IN ('completed','failed') OR p_result IS NULL OR pg_catalog.jsonb_typeof(p_result)<>'object' THEN
    RAISE EXCEPTION 'invalid AI completion input';
  END IF;

  UPDATE public.suite_ai_actions
  SET status=p_status,result=p_result,last_error=p_last_error,lease_expires_at=NULL,updated_at=pg_catalog.now()
  WHERE id=p_action_id AND status='running'
  RETURNING * INTO v_action;
  IF v_action.id IS NULL THEN RETURN FALSE; END IF;

  IF v_action.context->'resultContract'->>'version'='core-business-ai-result.v1' THEN
    IF COALESCE(v_action.context->>'aiAuditRecordId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'core AI action has no valid audit record';
    END IF;
    v_audit_id := (v_action.context->>'aiAuditRecordId')::UUID;

    IF p_status='completed' THEN
      IF pg_catalog.jsonb_typeof(p_result->'proposal') IS DISTINCT FROM 'string'
        OR pg_catalog.length(COALESCE(p_result->>'proposal','')) NOT BETWEEN 1 AND 20000 THEN
        RAISE EXCEPTION 'core AI completion violates its trusted result contract';
      END IF;
      IF pg_catalog.jsonb_typeof(p_result->'evidence') IS DISTINCT FROM 'array'
        OR pg_catalog.jsonb_typeof(v_action.context->'evidenceIds') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'core AI completion violates its trusted result contract';
      END IF;
      IF pg_catalog.jsonb_array_length(p_result->'evidence')>100
        OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_result->'evidence') AS evidence_item(value) WHERE pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'string')
        OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text(p_result->'evidence') AS evidence_item(value) WHERE NOT ((v_action.context->'evidenceIds') ? value)) THEN
        RAISE EXCEPTION 'core AI completion violates its trusted result contract';
      END IF;
      IF pg_catalog.jsonb_typeof(p_result->'confidence') IS DISTINCT FROM 'number'
        OR (p_result->>'confidence')::NUMERIC<0
        OR (p_result->>'confidence')::NUMERIC>1 THEN
        RAISE EXCEPTION 'core AI completion violates its trusted result contract';
      END IF;
      IF pg_catalog.jsonb_typeof(p_result->'assumptions') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'core AI completion violates its trusted result contract';
      END IF;
      IF pg_catalog.jsonb_array_length(p_result->'assumptions')>50
        OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_result->'assumptions') AS assumption_item(value) WHERE pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'string' OR pg_catalog.length(value#>>'{}') NOT BETWEEN 1 AND 1000) THEN
        RAISE EXCEPTION 'core AI completion violates its trusted result contract';
      END IF;
      IF p_result->>'reviewStatus' IS DISTINCT FROM 'pending-human-review'
        OR p_result->'approvalRequired' IS DISTINCT FROM 'true'::JSONB
        OR pg_catalog.jsonb_typeof(p_result->'model') IS DISTINCT FROM 'string'
        OR pg_catalog.length(COALESCE(p_result->>'model','')) NOT BETWEEN 1 AND 200
        OR COALESCE(p_result->>'resultSha256','') !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'core AI completion violates its trusted result contract';
      END IF;

      UPDATE public.suite_records
      SET state='pending-human-review',
          data=data||pg_catalog.jsonb_build_object(
            'aiActionId',v_action.id,
            'executedModel',p_result->>'model',
            'confidence',p_result->'confidence',
            'evidenceIds',p_result->'evidence',
            'assumptions',p_result->'assumptions',
            'reviewStatus','pending-human-review',
            'approvalRequired',TRUE,
            'resultHash',p_result->>'resultSha256',
            'completedAt',pg_catalog.now()
          ),
          updated_at=pg_catalog.now()
      WHERE id=v_audit_id
        AND workspace_id=v_action.workspace_id
        AND module_id=v_action.module_id
        AND record_type='ai-request-audit'
        AND data->>'promptDigest'=v_action.context->>'promptDigest'
        AND data->>'reviewStatus'='pending-model'
      RETURNING id INTO v_updated;
      IF v_updated IS NULL THEN RAISE EXCEPTION 'core AI audit record is missing or stale'; END IF;
    ELSE
      UPDATE public.suite_records
      SET state='model-failed',
          data=data||pg_catalog.jsonb_build_object('aiActionId',v_action.id,'reviewStatus','model-failed','modelError',COALESCE(p_last_error,'Model execution failed.'),'failedAt',pg_catalog.now()),
          updated_at=pg_catalog.now()
      WHERE id=v_audit_id
        AND workspace_id=v_action.workspace_id
        AND module_id=v_action.module_id
        AND record_type='ai-request-audit'
        AND data->>'promptDigest'=v_action.context->>'promptDigest'
        AND data->>'reviewStatus'='pending-model'
      RETURNING id INTO v_updated;
      IF v_updated IS NULL THEN RAISE EXCEPTION 'core AI audit record is missing or stale'; END IF;
    END IF;
  ELSIF v_action.context->'resultContract'->>'version'='first-party-growth-ai-result.v1' THEN
    IF COALESCE(v_action.context->>'aiAuditRecordId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'first-party growth AI action has no valid audit record';
    END IF;
    v_audit_id := (v_action.context->>'aiAuditRecordId')::UUID;

    IF p_status='completed' THEN
      IF p_result->>'version' IS DISTINCT FROM 'first-party-growth-ai-result.v1'
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_object_keys(p_result) AS result_key(key)
          WHERE key NOT IN ('version','proposal','evidence','confidence','assumptions','reviewStatus','approvalRequired','model')
        )
        OR pg_catalog.jsonb_typeof(p_result->'proposal') IS DISTINCT FROM 'string'
        OR pg_catalog.length(COALESCE(p_result->>'proposal','')) NOT BETWEEN 1 AND 20000 THEN
        RAISE EXCEPTION 'first-party growth AI completion violates its trusted result contract';
      END IF;
      IF pg_catalog.jsonb_typeof(p_result->'evidence') IS DISTINCT FROM 'array'
        OR pg_catalog.jsonb_typeof(v_action.context->'evidenceIds') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'first-party growth AI completion violates its trusted result contract';
      END IF;
      IF pg_catalog.jsonb_array_length(p_result->'evidence')>100
        OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_result->'evidence') AS evidence_item(value) WHERE pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'string')
        OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text(p_result->'evidence') AS evidence_item(value) WHERE NOT ((v_action.context->'evidenceIds') ? value)) THEN
        RAISE EXCEPTION 'first-party growth AI completion violates its trusted result contract';
      END IF;
      IF pg_catalog.jsonb_typeof(p_result->'confidence') IS DISTINCT FROM 'number'
        OR (p_result->>'confidence')::NUMERIC<0
        OR (p_result->>'confidence')::NUMERIC>1
        OR pg_catalog.jsonb_typeof(p_result->'assumptions') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'first-party growth AI completion violates its trusted result contract';
      END IF;
      IF pg_catalog.jsonb_array_length(p_result->'assumptions')>50
        OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_result->'assumptions') AS assumption_item(value) WHERE pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'string' OR pg_catalog.length(value#>>'{}') NOT BETWEEN 1 AND 1000) THEN
        RAISE EXCEPTION 'first-party growth AI completion violates its trusted result contract';
      END IF;
      IF p_result->>'reviewStatus' IS DISTINCT FROM 'pending-human-review'
        OR p_result->'approvalRequired' IS DISTINCT FROM 'true'::JSONB
        OR pg_catalog.jsonb_typeof(p_result->'model') IS DISTINCT FROM 'string'
        OR pg_catalog.length(COALESCE(p_result->>'model','')) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'first-party growth AI completion violates its trusted result contract';
      END IF;

      UPDATE public.suite_records
      SET state='pending-human-review',
          data=data||pg_catalog.jsonb_build_object(
            'aiActionId',v_action.id,
            'executedModel',p_result->>'model',
            'confidence',p_result->'confidence',
            'evidenceIds',p_result->'evidence',
            'assumptions',p_result->'assumptions',
            'reviewStatus','pending-human-review',
            'approvalRequired',TRUE,
            'completedAt',pg_catalog.now()
          ),
          updated_at=pg_catalog.now()
      WHERE id=v_audit_id
        AND workspace_id=v_action.workspace_id
        AND module_id=v_action.module_id
        AND record_type='ai-request-audit'
        AND data->>'promptDigest'=v_action.context->>'promptDigest'
        AND data->>'reviewStatus'='pending-model'
      RETURNING id INTO v_updated;
      IF v_updated IS NULL THEN RAISE EXCEPTION 'first-party growth AI audit record is missing or stale'; END IF;
    ELSE
      UPDATE public.suite_records
      SET state='model-failed',
          data=data||pg_catalog.jsonb_build_object('aiActionId',v_action.id,'reviewStatus','model-failed','modelError',COALESCE(p_last_error,'Model execution failed.'),'failedAt',pg_catalog.now()),
          updated_at=pg_catalog.now()
      WHERE id=v_audit_id
        AND workspace_id=v_action.workspace_id
        AND module_id=v_action.module_id
        AND record_type='ai-request-audit'
        AND data->>'promptDigest'=v_action.context->>'promptDigest'
        AND data->>'reviewStatus'='pending-model'
      RETURNING id INTO v_updated;
      IF v_updated IS NULL THEN RAISE EXCEPTION 'first-party growth AI audit record is missing or stale'; END IF;
    END IF;
  ELSIF v_action.context->'resultContract'->>'version'='premium-business-ai-result.v1' THEN
    IF COALESCE(v_action.context->>'aiAuditRecordId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'premium AI action has no valid audit record';
    END IF;
    v_audit_id := (v_action.context->>'aiAuditRecordId')::UUID;

    IF p_status='completed' THEN
      IF pg_catalog.jsonb_typeof(p_result->'output') IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(p_result->'evidenceIds') IS DISTINCT FROM 'array'
        OR pg_catalog.jsonb_typeof(v_action.context->'evidenceIds') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'premium AI completion violates its trusted result contract';
      END IF;
      IF pg_catalog.jsonb_typeof(p_result->'output'->'summary') IS DISTINCT FROM 'string'
        OR pg_catalog.length(COALESCE(p_result->'output'->>'summary','')) NOT BETWEEN 1 AND 20000
        OR pg_catalog.jsonb_typeof(p_result->'output'->'claims') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'premium AI completion violates its trusted result contract';
      END IF;
      IF pg_catalog.jsonb_array_length(p_result->'evidenceIds') NOT BETWEEN 1 AND 100
        OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_result->'evidenceIds') AS evidence_item(value) WHERE pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'string')
        OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text(p_result->'evidenceIds') AS evidence_item(value) WHERE NOT ((v_action.context->'evidenceIds') ? value))
        OR pg_catalog.jsonb_array_length(p_result->'output'->'claims') NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'premium AI completion violates its trusted result contract';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_result->'output'->'claims') AS claim_item(value)
        WHERE pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'object'
          OR pg_catalog.jsonb_typeof(value->'text') IS DISTINCT FROM 'string'
          OR pg_catalog.length(COALESCE(value->>'text','')) NOT BETWEEN 1 AND 20000
          OR pg_catalog.jsonb_typeof(value->'evidenceIds') IS DISTINCT FROM 'array'
      ) THEN
        RAISE EXCEPTION 'premium AI completion violates its trusted result contract';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_result->'output'->'claims') AS claim_item(value)
        WHERE pg_catalog.jsonb_array_length(value->'evidenceIds') NOT BETWEEN 1 AND 100
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(value->'evidenceIds') AS claim_evidence(item)
            WHERE pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'string'
          )
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements_text(value->'evidenceIds') AS claim_evidence(item)
            WHERE NOT ((p_result->'evidenceIds') ? item)
              OR NOT ((v_action.context->'evidenceIds') ? item)
          )
      ) THEN
        RAISE EXCEPTION 'premium AI completion violates its trusted result contract';
      END IF;
      IF pg_catalog.jsonb_typeof(p_result->'confidence') IS DISTINCT FROM 'number'
        OR (p_result->>'confidence')::NUMERIC<0
        OR (p_result->>'confidence')::NUMERIC>100
        OR (p_result->>'confidence')::NUMERIC<>pg_catalog.trunc((p_result->>'confidence')::NUMERIC)
        OR p_result->>'promptVersion' IS DISTINCT FROM v_action.context->>'promptVersion'
        OR p_result->>'modelId' IS DISTINCT FROM v_action.context->>'requestedModelId'
        OR p_result->>'reviewStatus' IS DISTINCT FROM 'pending-human-review'
        OR p_result->'approvalRequired' IS DISTINCT FROM 'true'::JSONB THEN
        RAISE EXCEPTION 'premium AI completion violates its trusted result contract';
      END IF;

      UPDATE public.suite_records
      SET state='pending-human-review',
          data=data||pg_catalog.jsonb_build_object(
            'aiActionId',v_action.id,
            'executedModelId',p_result->>'modelId',
            'confidence',p_result->'confidence',
            'resultEvidenceIds',p_result->'evidenceIds',
            'review',pg_catalog.jsonb_build_object('status','pending-human-review','required',TRUE),
            'completedAt',pg_catalog.now()
          ),
          updated_at=pg_catalog.now()
      WHERE id=v_audit_id
        AND workspace_id=v_action.workspace_id
        AND module_id=v_action.module_id
        AND record_type='premium-ai-request-audit'
        AND data->>'promptVersion'=v_action.context->>'promptVersion'
        AND data->>'requestedModelId'=v_action.context->>'requestedModelId'
        AND data->>'platformPromptDigest'=v_action.context->>'platformPromptDigest'
        AND data->'review'->>'status'='pending-model'
      RETURNING id INTO v_updated;
      IF v_updated IS NULL THEN RAISE EXCEPTION 'premium AI audit record is missing or stale'; END IF;
    ELSE
      UPDATE public.suite_records
      SET state='model-failed',
          data=data||pg_catalog.jsonb_build_object('aiActionId',v_action.id,'review',pg_catalog.jsonb_build_object('status','model-failed','required',TRUE),'modelError',COALESCE(p_last_error,'Model execution failed.'),'failedAt',pg_catalog.now()),
          updated_at=pg_catalog.now()
      WHERE id=v_audit_id
        AND workspace_id=v_action.workspace_id
        AND module_id=v_action.module_id
        AND record_type='premium-ai-request-audit'
        AND data->>'platformPromptDigest'=v_action.context->>'platformPromptDigest'
        AND data->'review'->>'status'='pending-model'
      RETURNING id INTO v_updated;
      IF v_updated IS NULL THEN RAISE EXCEPTION 'premium AI audit record is missing or stale'; END IF;
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('app.workspace_id',v_action.workspace_id::TEXT,TRUE);
  RETURN TRUE;
END
$function$;

ALTER FUNCTION managed_oss_complete_suite_ai_action(UUID,TEXT,JSONB,TEXT) OWNER TO managed_oss_suite_owner;
REVOKE ALL ON FUNCTION managed_oss_complete_suite_ai_action(UUID,TEXT,JSONB,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION managed_oss_complete_suite_ai_action(UUID,TEXT,JSONB,TEXT) TO managed_oss_ai;
