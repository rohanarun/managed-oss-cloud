DO $pgcrypto_preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pgcrypto')
    OR pg_catalog.to_regprocedure('public.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'migration 016 requires the pgcrypto extension in the public schema; install it once with a database-administrator connection before running scoped migrations';
  END IF;
END
$pgcrypto_preflight$;

-- managed-oss-canonical-json.v1 is a self-delimiting UTF-8 token stream:
-- N null; T/F booleans; D<byte-count>:<minimal exponent-free decimal> numbers;
-- S<byte-count>:<UTF-8 hex> strings; A<count>:<ordered values> arrays; and
-- O<count>:<UTF-8-byte-sorted key/value pairs> objects. The public encoding
-- starts with "managed-oss-canonical-json.v1|" before the root value token.
CREATE OR REPLACE FUNCTION managed_oss_canonical_jsonb_value_v1(p_value JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path=pg_catalog
AS $function$
DECLARE
  v_result TEXT;
  v_bytes BYTEA;
  v_number TEXT;
BEGIN
  CASE pg_catalog.jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT 'O'||pg_catalog.count(*)::TEXT||':'||COALESCE(
        pg_catalog.string_agg(
          'S'||pg_catalog.octet_length(pg_catalog.convert_to(entry.key,'UTF8'))::TEXT||':'
            ||pg_catalog.encode(pg_catalog.convert_to(entry.key,'UTF8'),'hex')
            ||public.managed_oss_canonical_jsonb_value_v1(entry.value),
          '' ORDER BY pg_catalog.convert_to(entry.key,'UTF8')
        ),
        ''
      )
      INTO v_result
      FROM pg_catalog.jsonb_each(p_value) AS entry(key,value);
    WHEN 'array' THEN
      SELECT 'A'||pg_catalog.count(*)::TEXT||':'||COALESCE(
        pg_catalog.string_agg(public.managed_oss_canonical_jsonb_value_v1(entry.value),'' ORDER BY entry.position),
        ''
      )
      INTO v_result
      FROM pg_catalog.jsonb_array_elements(p_value) WITH ORDINALITY AS entry(value,position);
    WHEN 'string' THEN
      v_bytes := pg_catalog.convert_to(p_value#>>'{}','UTF8');
      v_result := 'S'||pg_catalog.octet_length(v_bytes)::TEXT||':'||pg_catalog.encode(v_bytes,'hex');
    WHEN 'number' THEN
      v_number := pg_catalog.trim_scale((p_value#>>'{}')::NUMERIC)::TEXT;
      v_result := 'D'||pg_catalog.octet_length(pg_catalog.convert_to(v_number,'UTF8'))::TEXT||':'||v_number;
    WHEN 'boolean' THEN
      v_result := CASE WHEN p_value='true'::JSONB THEN 'T' ELSE 'F' END;
    WHEN 'null' THEN
      v_result := 'N';
    ELSE
      RAISE EXCEPTION 'canonical JSON v1 received an unsupported JSONB value';
  END CASE;
  RETURN v_result;
END
$function$;

ALTER FUNCTION managed_oss_canonical_jsonb_value_v1(JSONB) OWNER TO managed_oss_suite_owner;
REVOKE ALL ON FUNCTION managed_oss_canonical_jsonb_value_v1(JSONB) FROM PUBLIC,managed_oss_runtime,managed_oss_ai;

CREATE OR REPLACE FUNCTION managed_oss_canonical_jsonb(p_value JSONB)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
SET search_path=pg_catalog
AS $function$
  SELECT 'managed-oss-canonical-json.v1|'||public.managed_oss_canonical_jsonb_value_v1(p_value)
$function$;

ALTER FUNCTION managed_oss_canonical_jsonb(JSONB) OWNER TO managed_oss_suite_owner;
REVOKE ALL ON FUNCTION managed_oss_canonical_jsonb(JSONB) FROM PUBLIC,managed_oss_runtime,managed_oss_ai;

CREATE OR REPLACE FUNCTION managed_oss_complete_suite_ai_action_v4(
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
  v_audit public.suite_records%ROWTYPE;
  v_contract TEXT;
  v_audit_id UUID;
  v_nested JSONB;
  v_nested_data JSONB;
  v_binding JSONB;
  v_record public.suite_records%ROWTYPE;
  v_record_version NUMERIC;
  v_snapshot JSONB;
  v_snapshot_hash TEXT;
  v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
  SELECT * INTO v_action
  FROM public.suite_ai_actions
  WHERE id=p_action_id AND status='running'
  FOR UPDATE;
  IF v_action.id IS NULL THEN RETURN FALSE; END IF;

  v_contract := v_action.context->'resultContract'->>'version';
  IF v_contract IS NULL OR v_contract NOT IN ('additive-business-proposal.v1','extended-business-proposal.v1') THEN
    IF v_action.context ? 'resultContract'
      AND (v_contract IS NULL OR v_contract NOT IN ('core-business-ai-result.v1','premium-business-ai-result.v1','first-party-growth-ai-result.v1','esign-ai-result.v1','letterline-ai-result.v1')) THEN
      IF p_status IS DISTINCT FROM 'failed'
        OR p_result IS NULL
        OR pg_catalog.jsonb_typeof(p_result) IS DISTINCT FROM 'object'
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_result)) IS DISTINCT FROM 1::BIGINT
        OR pg_catalog.jsonb_typeof(p_result->'error') IS DISTINCT FROM 'string'
        OR pg_catalog.length(pg_catalog.btrim(COALESCE(p_result->>'error',''))) NOT BETWEEN 1 AND 2000 THEN
        RAISE EXCEPTION 'unknown or invalid AI result contract version';
      END IF;
      UPDATE public.suite_ai_actions
      SET status='failed',result=p_result,last_error=p_result->>'error',lease_expires_at=NULL,updated_at=v_now
      WHERE id=v_action.id AND status='running';
      RETURN TRUE;
    END IF;
    RETURN public.managed_oss_complete_suite_ai_action_v3(p_action_id,p_status,p_result,p_last_error);
  END IF;

  IF p_status NOT IN ('completed','failed') OR p_result IS NULL OR pg_catalog.jsonb_typeof(p_result) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid proposal-only AI completion input';
  END IF;
  IF pg_catalog.jsonb_typeof(v_action.context->'evidenceIds') IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(v_action.context->'evidenceIds') NOT BETWEEN 1 AND 500
    OR pg_catalog.jsonb_typeof(v_action.context->'evidenceBindings') IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(v_action.context->'evidenceBindings') IS DISTINCT FROM pg_catalog.jsonb_array_length(v_action.context->'evidenceIds') THEN
    RAISE EXCEPTION 'proposal-only AI action has an invalid evidence boundary';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(v_action.context->'evidenceIds') AS evidence_item(value)
    WHERE pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'string'
      OR value#>>'{}' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  ) OR (
    SELECT pg_catalog.count(*) IS DISTINCT FROM pg_catalog.count(DISTINCT value#>>'{}')
    FROM pg_catalog.jsonb_array_elements(v_action.context->'evidenceIds') AS evidence_item(value)
  ) THEN
    RAISE EXCEPTION 'proposal-only evidence IDs must be exact and unique';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_action.context->'evidenceBindings') WITH ORDINALITY AS binding_item(value,position)
    WHERE pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'object'
      OR EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_object_keys(value) AS binding_key(key)
        WHERE (v_contract='additive-business-proposal.v1' AND key NOT IN ('recordId','moduleId','recordType','version','contentHash'))
          OR (v_contract='extended-business-proposal.v1' AND key NOT IN ('recordId','moduleId','recordType','version','snapshotHash'))
      )
      OR COALESCE(value->>'recordId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR pg_catalog.length(pg_catalog.btrim(COALESCE(value->>'moduleId',''))) NOT BETWEEN 1 AND 100
      OR pg_catalog.length(pg_catalog.btrim(COALESCE(value->>'recordType',''))) NOT BETWEEN 1 AND 200
      OR pg_catalog.jsonb_typeof(value->'version') IS DISTINCT FROM 'number'
      OR COALESCE(value->>'version','') !~ '^[1-9][0-9]*$'
      OR (value->>'version')::NUMERIC > 9007199254740991
      OR (v_contract='additive-business-proposal.v1' AND COALESCE(value->>'contentHash','') !~ '^[a-f0-9]{64}$')
      OR (v_contract='extended-business-proposal.v1' AND COALESCE(value->>'snapshotHash','') !~ '^[a-f0-9]{64}$')
      OR value->>'recordId' IS DISTINCT FROM v_action.context->'evidenceIds'->>(position::INTEGER-1)
  ) OR (
    SELECT pg_catalog.count(*) IS DISTINCT FROM pg_catalog.count(DISTINCT value->>'recordId')
    FROM pg_catalog.jsonb_array_elements(v_action.context->'evidenceBindings') AS binding_item(value)
  ) THEN
    RAISE EXCEPTION 'proposal-only evidence bindings must be exact, unique, typed, versioned, and hashed';
  END IF;

  IF p_status='completed' THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_object_keys(p_result) AS result_key(key)
      WHERE key NOT IN ('version','proposal','evidence','confidence','assumptions','model','reviewStatus','approvalRequired','proposalOnly','automaticMutationAllowed','externalEffectAllowed')
    )
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_result)) IS DISTINCT FROM 11::BIGINT
      OR p_result->>'version' IS DISTINCT FROM v_contract
      OR pg_catalog.jsonb_typeof(p_result->'proposal') IS DISTINCT FROM 'string'
      OR pg_catalog.length(pg_catalog.btrim(COALESCE(p_result->>'proposal',''))) NOT BETWEEN 1 AND 20000
      OR pg_catalog.jsonb_typeof(p_result->'evidence') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(p_result->'evidence') NOT BETWEEN 1 AND 500
      OR pg_catalog.jsonb_typeof(p_result->'confidence') IS DISTINCT FROM 'number'
      OR (p_result->>'confidence')::NUMERIC<0
      OR (p_result->>'confidence')::NUMERIC>1
      OR pg_catalog.jsonb_typeof(p_result->'assumptions') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(p_result->'assumptions')>50
      OR pg_catalog.jsonb_typeof(p_result->'model') IS DISTINCT FROM 'string'
      OR pg_catalog.length(pg_catalog.btrim(COALESCE(p_result->>'model',''))) NOT BETWEEN 1 AND 200
      OR p_result->>'reviewStatus' IS DISTINCT FROM 'pending-human-review'
      OR p_result->'approvalRequired' IS DISTINCT FROM 'true'::JSONB
      OR p_result->'proposalOnly' IS DISTINCT FROM 'true'::JSONB
      OR p_result->'automaticMutationAllowed' IS DISTINCT FROM 'false'::JSONB
      OR p_result->'externalEffectAllowed' IS DISTINCT FROM 'false'::JSONB THEN
      RAISE EXCEPTION 'proposal-only AI completion violates its trusted result contract';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(p_result->'evidence') AS evidence_item(value)
      WHERE pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'string'
        OR value#>>'{}' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        OR (NOT ((v_action.context->'evidenceIds') ? (value#>>'{}')) AND value#>>'{}' IS DISTINCT FROM v_action.context->>'targetRecordId')
    ) OR (
      SELECT pg_catalog.count(*) IS DISTINCT FROM pg_catalog.count(DISTINCT value#>>'{}')
      FROM pg_catalog.jsonb_array_elements(p_result->'evidence') AS evidence_item(value)
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(p_result->'assumptions') AS assumption_item(value)
      WHERE pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'string'
        OR pg_catalog.length(pg_catalog.btrim(value#>>'{}')) NOT BETWEEN 1 AND 1000
    ) THEN
      RAISE EXCEPTION 'proposal-only AI completion violates its trusted result contract';
    END IF;
    IF pg_catalog.length(pg_catalog.btrim(COALESCE(v_action.context->>'requestedModelId',''))) NOT BETWEEN 1 AND 200
      OR p_result->>'model' IS DISTINCT FROM v_action.context->>'requestedModelId'
      OR (v_contract='extended-business-proposal.v1' AND (
        pg_catalog.length(pg_catalog.btrim(COALESCE(v_action.context->>'modelPolicyId',''))) NOT BETWEEN 1 AND 200
        OR p_result->>'model' IS DISTINCT FROM v_action.context->>'modelPolicyId'
      )) THEN
      RAISE EXCEPTION 'proposal-only AI completion does not match every configured model field';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_result) AS result_key(key) WHERE key<>'error')
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_result)) IS DISTINCT FROM 1::BIGINT
      OR pg_catalog.jsonb_typeof(p_result->'error') IS DISTINCT FROM 'string'
      OR pg_catalog.length(pg_catalog.btrim(COALESCE(p_result->>'error',''))) NOT BETWEEN 1 AND 2000
      OR p_last_error IS DISTINCT FROM p_result->>'error' THEN
      RAISE EXCEPTION 'proposal-only AI failure violates its trusted error contract';
    END IF;
  END IF;

  IF v_contract='additive-business-proposal.v1' THEN
    IF COALESCE(v_action.context->>'requestRecordId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR COALESCE(v_action.context->>'targetRecordId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR NOT ((v_action.context->'evidenceIds') ? (v_action.context->>'targetRecordId')) THEN
      RAISE EXCEPTION 'additive proposal action has an invalid audit or target record ID';
    END IF;
    v_audit_id := (v_action.context->>'requestRecordId')::UUID;
  ELSE
    IF COALESCE(v_action.context->>'aiAuditRecordId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'extended proposal action has no valid audit record ID';
    END IF;
    IF v_action.context ? 'targetRecordId' THEN
      IF COALESCE(v_action.context->>'targetRecordId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        OR pg_catalog.jsonb_typeof(v_action.context->'targetVersion') IS DISTINCT FROM 'number'
        OR COALESCE(v_action.context->>'targetVersion','') !~ '^[1-9][0-9]*$'
        OR (v_action.context->>'targetVersion')::NUMERIC > 9007199254740991
        OR COALESCE(v_action.context->>'targetSnapshotHash','') !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'extended proposal action has an invalid target binding';
      END IF;
    ELSIF v_action.context ? 'targetVersion' OR v_action.context ? 'targetSnapshotHash' THEN
      RAISE EXCEPTION 'extended proposal target version and hash require a target record ID';
    END IF;
    v_audit_id := (v_action.context->>'aiAuditRecordId')::UUID;
  END IF;

  SELECT * INTO v_audit
  FROM public.suite_records
  WHERE id=v_audit_id
    AND workspace_id=v_action.workspace_id
    AND module_id=v_action.module_id
    AND record_type='ai-proposal-request'
    AND state='queued'
  FOR UPDATE;
  IF v_audit.id IS NULL THEN RAISE EXCEPTION 'proposal-only audit record is missing, stale, or cross-tenant'; END IF;

  IF v_contract='additive-business-proposal.v1' THEN
    IF v_audit.data->>'additiveContract' IS DISTINCT FROM 'additive-business-record.v1'
      OR pg_catalog.jsonb_typeof(v_audit.data->'record') IS DISTINCT FROM 'object'
      OR v_audit.data->'record'->>'id' IS DISTINCT FROM v_audit.id::TEXT
      OR v_audit.data->'record'->>'workspaceId' IS DISTINCT FROM v_action.workspace_id::TEXT
      OR v_audit.data->'record'->>'moduleId' IS DISTINCT FROM v_action.module_id
      OR v_audit.data->'record'->>'recordType' IS DISTINCT FROM 'ai-proposal-request'
      OR v_audit.data->'record'->>'title' IS DISTINCT FROM v_audit.title
      OR v_audit.data->'record'->>'state' IS DISTINCT FROM 'queued'
      OR pg_catalog.jsonb_typeof(v_audit.data->'record'->'version') IS DISTINCT FROM 'number'
      OR COALESCE(v_audit.data->'record'->>'version','') !~ '^[1-9][0-9]*$'
      OR (v_audit.data->'record'->>'version')::NUMERIC > 9007199254740991
      OR COALESCE(v_audit.data->'record'->>'contentHash','') !~ '^[a-f0-9]{64}$'
      OR pg_catalog.jsonb_typeof(v_audit.data->'record'->'data') IS DISTINCT FROM 'object'
      OR v_audit.data->'record'->'data'->>'queuedActionId' IS DISTINCT FROM v_action.id::TEXT
      OR v_audit.data->'record'->'data'->>'targetRecordId' IS DISTINCT FROM v_action.context->>'targetRecordId'
      OR v_audit.data->'record'->'data'->>'requestedModelId' IS DISTINCT FROM v_action.context->>'requestedModelId'
      OR v_audit.data->'record'->'data'->'prompt' IS DISTINCT FROM v_action.context->'prompt'
      OR v_audit.data->'record'->'data'->'evidenceIds' IS DISTINCT FROM v_action.context->'evidenceIds'
      OR v_audit.data->'record'->'data'->'evidenceBindings' IS DISTINCT FROM v_action.context->'evidenceBindings'
      OR v_audit.data->'record'->'data'->'review'->>'status' IS DISTINCT FROM 'pending-model'
      OR v_audit.data->'record'->'data'->'review'->'required' IS DISTINCT FROM 'true'::JSONB
      OR v_audit.data->'record'->'data'->'proposalOnly' IS DISTINCT FROM 'true'::JSONB
      OR v_audit.data->'record'->'data'->'automaticMutationAllowed' IS DISTINCT FROM 'false'::JSONB
      OR v_audit.data->'record'->'data'->'applyActionId' IS DISTINCT FROM 'null'::JSONB
      OR v_audit.data->'record'->'data'->'modelExecuted' IS DISTINCT FROM 'false'::JSONB THEN
      RAISE EXCEPTION 'additive proposal audit record does not match its queued boundary';
    END IF;
    v_nested := v_audit.data->'record';
    v_snapshot := pg_catalog.jsonb_build_object(
      'moduleId',v_nested->'moduleId','recordType',v_nested->'recordType','title',v_nested->'title',
      'state',v_nested->'state','version',v_nested->'version','data',v_nested->'data'
    );
    v_snapshot_hash := pg_catalog.encode(public.digest(pg_catalog.convert_to(public.managed_oss_canonical_jsonb(v_snapshot),'UTF8'),'sha256'),'hex');
    IF v_snapshot_hash IS DISTINCT FROM v_nested->>'contentHash' THEN
      RAISE EXCEPTION 'additive proposal audit record content hash is invalid';
    END IF;
  ELSE
    IF v_audit.data->>'actionId' IS DISTINCT FROM v_action.context->>'actionId'
      OR v_audit.data->>'promptId' IS DISTINCT FROM v_action.context->>'promptId'
      OR v_audit.data->>'promptVersion' IS DISTINCT FROM v_action.context->>'promptVersion'
      OR v_audit.data->>'modelPolicyId' IS DISTINCT FROM v_action.context->>'modelPolicyId'
      OR v_audit.data->>'requestedModelId' IS DISTINCT FROM v_action.context->>'requestedModelId'
      OR v_audit.data->'evidenceIds' IS DISTINCT FROM v_action.context->'evidenceIds'
      OR v_audit.data->'evidenceBindings' IS DISTINCT FROM v_action.context->'evidenceBindings'
      OR v_audit.data->>'targetRecordId' IS DISTINCT FROM v_action.context->>'targetRecordId'
      OR v_audit.data->'targetVersion' IS DISTINCT FROM v_action.context->'targetVersion'
      OR v_audit.data->>'targetSnapshotHash' IS DISTINCT FROM v_action.context->>'targetSnapshotHash'
      OR v_audit.data->>'reviewStatus' IS DISTINCT FROM 'pending-model'
      OR v_audit.data->'proposalOnly' IS DISTINCT FROM 'true'::JSONB
      OR v_audit.data->'automaticMutationAllowed' IS DISTINCT FROM 'false'::JSONB
      OR v_audit.data->'externalEffectAllowed' IS DISTINCT FROM 'false'::JSONB THEN
      RAISE EXCEPTION 'extended proposal audit record does not match its queued boundary';
    END IF;
  END IF;

  IF p_status='completed' THEN
    FOR v_binding IN SELECT value FROM pg_catalog.jsonb_array_elements(v_action.context->'evidenceBindings') AS binding_item(value)
    LOOP
      SELECT * INTO v_record
      FROM public.suite_records
      WHERE id=(v_binding->>'recordId')::UUID
        AND workspace_id=v_action.workspace_id
      FOR UPDATE;
      IF v_record.id IS NULL
        OR v_record.module_id IS DISTINCT FROM v_binding->>'moduleId'
        OR v_record.record_type IS DISTINCT FROM v_binding->>'recordType' THEN
        RAISE EXCEPTION 'proposal-only evidence changed tenant, module, or record type before completion';
      END IF;

      IF v_record.data ? 'version' THEN
        IF pg_catalog.jsonb_typeof(v_record.data->'version') IS DISTINCT FROM 'number'
          OR COALESCE(v_record.data->>'version','') !~ '^[1-9][0-9]*$'
          OR (v_record.data->>'version')::NUMERIC > 9007199254740991 THEN
          RAISE EXCEPTION 'proposal-only evidence has an invalid current version';
        END IF;
        v_record_version := (v_record.data->>'version')::NUMERIC;
      ELSE
        v_record_version := 1;
      END IF;

      IF v_contract='additive-business-proposal.v1' AND v_record.module_id IN ('tables','meetings','insights','learning','community') THEN
        IF v_record.data->>'additiveContract' IS DISTINCT FROM 'additive-business-record.v1'
          OR pg_catalog.jsonb_typeof(v_record.data->'record') IS DISTINCT FROM 'object'
          OR v_record.data->'record'->>'id' IS DISTINCT FROM v_record.id::TEXT
          OR v_record.data->'record'->>'workspaceId' IS DISTINCT FROM v_record.workspace_id::TEXT
          OR v_record.data->'record'->>'moduleId' IS DISTINCT FROM v_record.module_id
          OR v_record.data->'record'->>'recordType' IS DISTINCT FROM v_record.record_type
          OR v_record.data->'record'->>'title' IS DISTINCT FROM v_record.title
          OR v_record.data->'record'->>'state' IS DISTINCT FROM v_record.state
          OR pg_catalog.jsonb_typeof(v_record.data->'record'->'version') IS DISTINCT FROM 'number'
          OR COALESCE(v_record.data->'record'->>'version','') !~ '^[1-9][0-9]*$'
          OR COALESCE(v_record.data->'record'->>'contentHash','') !~ '^[a-f0-9]{64}$'
          OR pg_catalog.jsonb_typeof(v_record.data->'record'->'data') IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'additive evidence envelope is invalid at completion';
        END IF;
        v_record_version := (v_record.data->'record'->>'version')::NUMERIC;
        v_snapshot := pg_catalog.jsonb_build_object(
          'moduleId',v_record.module_id,'recordType',v_record.record_type,'title',v_record.title,'state',v_record.state,
          'version',v_record.data->'record'->'version','data',v_record.data->'record'->'data'
        );
        v_snapshot_hash := pg_catalog.encode(public.digest(pg_catalog.convert_to(public.managed_oss_canonical_jsonb(v_snapshot),'UTF8'),'sha256'),'hex');
        IF v_snapshot_hash IS DISTINCT FROM v_record.data->'record'->>'contentHash' THEN
          RAISE EXCEPTION 'additive evidence content hash is invalid at completion';
        END IF;
      ELSIF v_contract='additive-business-proposal.v1' THEN
        v_snapshot := pg_catalog.jsonb_build_object(
          'contract','suite-record-evidence-snapshot.v1','id',v_record.id,'workspaceId',v_record.workspace_id,
          'moduleId',v_record.module_id,'recordType',v_record.record_type,'title',v_record.title,'state',v_record.state,
          'version',v_record_version,'data',v_record.data,
          'updatedAt',pg_catalog.to_char(v_record.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        );
        v_snapshot_hash := pg_catalog.encode(public.digest(pg_catalog.convert_to(public.managed_oss_canonical_jsonb(v_snapshot),'UTF8'),'sha256'),'hex');
      ELSE
        v_snapshot := pg_catalog.jsonb_build_object(
          'id',v_record.id,'workspaceId',v_record.workspace_id,'moduleId',v_record.module_id,'recordType',v_record.record_type,
          'title',v_record.title,'state',v_record.state,'data',v_record.data,
          'createdAt',pg_catalog.to_char(v_record.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'updatedAt',pg_catalog.to_char(v_record.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        );
        v_snapshot_hash := pg_catalog.encode(public.digest(pg_catalog.convert_to(public.managed_oss_canonical_jsonb(v_snapshot),'UTF8'),'sha256'),'hex');
      END IF;

      IF v_record_version IS DISTINCT FROM (v_binding->>'version')::NUMERIC
        OR (v_contract='additive-business-proposal.v1' AND v_snapshot_hash IS DISTINCT FROM v_binding->>'contentHash')
        OR (v_contract='extended-business-proposal.v1' AND v_snapshot_hash IS DISTINCT FROM v_binding->>'snapshotHash') THEN
        RAISE EXCEPTION 'proposal-only evidence version or hash changed before completion';
      END IF;
    END LOOP;

    IF v_contract='extended-business-proposal.v1' AND v_action.context ? 'targetRecordId' THEN
      SELECT * INTO v_record
      FROM public.suite_records
      WHERE id=(v_action.context->>'targetRecordId')::UUID
        AND workspace_id=v_action.workspace_id
        AND module_id=v_action.module_id
      FOR UPDATE;
      IF v_record.id IS NULL THEN RAISE EXCEPTION 'extended proposal target is missing or cross-tenant at completion'; END IF;
      IF v_record.data ? 'version' THEN
        IF pg_catalog.jsonb_typeof(v_record.data->'version') IS DISTINCT FROM 'number'
          OR COALESCE(v_record.data->>'version','') !~ '^[1-9][0-9]*$'
          OR (v_record.data->>'version')::NUMERIC > 9007199254740991 THEN
          RAISE EXCEPTION 'extended proposal target has an invalid current version';
        END IF;
        v_record_version := (v_record.data->>'version')::NUMERIC;
      ELSE
        v_record_version := 1;
      END IF;
      v_snapshot := pg_catalog.jsonb_build_object(
        'id',v_record.id,'workspaceId',v_record.workspace_id,'moduleId',v_record.module_id,'recordType',v_record.record_type,
        'title',v_record.title,'state',v_record.state,'data',v_record.data,
        'createdAt',pg_catalog.to_char(v_record.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updatedAt',pg_catalog.to_char(v_record.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      );
      v_snapshot_hash := pg_catalog.encode(public.digest(pg_catalog.convert_to(public.managed_oss_canonical_jsonb(v_snapshot),'UTF8'),'sha256'),'hex');
      IF v_record_version IS DISTINCT FROM (v_action.context->>'targetVersion')::NUMERIC
        OR v_snapshot_hash IS DISTINCT FROM v_action.context->>'targetSnapshotHash' THEN
        RAISE EXCEPTION 'extended proposal target version or hash changed before completion';
      END IF;
    END IF;
  END IF;

  UPDATE public.suite_ai_actions
  SET status=p_status,result=p_result,last_error=p_last_error,lease_expires_at=NULL,updated_at=v_now
  WHERE id=v_action.id AND status='running';

  IF v_contract='additive-business-proposal.v1' THEN
    v_nested := v_audit.data->'record';
    v_nested_data := v_nested->'data';
    IF p_status='completed' THEN
      v_nested_data := v_nested_data || pg_catalog.jsonb_build_object(
        'output',p_result->'proposal','confidence',p_result->'confidence','assumptions',p_result->'assumptions',
        'citedEvidenceIds',p_result->'evidence','review',(v_nested_data->'review')||'{"status":"pending-human-review"}'::JSONB,
        'executedModel',p_result->>'model','resultContractVersion',v_contract,'approvalRequired',TRUE,
        'proposalOnly',TRUE,'automaticMutationAllowed',FALSE,'externalEffectAllowed',FALSE,'modelExecuted',TRUE,'completedAt',v_now
      );
      v_nested := v_nested || pg_catalog.jsonb_build_object('state','pending-human-review','updatedAt',v_now,'data',v_nested_data);
      v_snapshot := pg_catalog.jsonb_build_object(
        'moduleId',v_nested->'moduleId','recordType',v_nested->'recordType','title',v_nested->'title',
        'state',v_nested->'state','version',v_nested->'version','data',v_nested->'data'
      );
      v_snapshot_hash := pg_catalog.encode(public.digest(pg_catalog.convert_to(public.managed_oss_canonical_jsonb(v_snapshot),'UTF8'),'sha256'),'hex');
      v_nested := v_nested || pg_catalog.jsonb_build_object('contentHash',v_snapshot_hash);
      UPDATE public.suite_records SET state='pending-human-review',data=pg_catalog.jsonb_set(data,'{record}',v_nested,TRUE),updated_at=v_now WHERE id=v_audit.id;
    ELSE
      v_nested_data := v_nested_data || pg_catalog.jsonb_build_object(
        'review',(v_nested_data->'review')||'{"status":"model-failed"}'::JSONB,'modelError',p_result->>'error',
        'proposalOnly',TRUE,'automaticMutationAllowed',FALSE,'externalEffectAllowed',FALSE,'modelCompleted',FALSE,'failedAt',v_now
      );
      v_nested := v_nested || pg_catalog.jsonb_build_object('state','model-failed','updatedAt',v_now,'data',v_nested_data);
      v_snapshot := pg_catalog.jsonb_build_object(
        'moduleId',v_nested->'moduleId','recordType',v_nested->'recordType','title',v_nested->'title',
        'state',v_nested->'state','version',v_nested->'version','data',v_nested->'data'
      );
      v_snapshot_hash := pg_catalog.encode(public.digest(pg_catalog.convert_to(public.managed_oss_canonical_jsonb(v_snapshot),'UTF8'),'sha256'),'hex');
      v_nested := v_nested || pg_catalog.jsonb_build_object('contentHash',v_snapshot_hash);
      UPDATE public.suite_records SET state='model-failed',data=pg_catalog.jsonb_set(data,'{record}',v_nested,TRUE),updated_at=v_now WHERE id=v_audit.id;
    END IF;
  ELSIF p_status='completed' THEN
    UPDATE public.suite_records
    SET state='pending-human-review',data=data||pg_catalog.jsonb_build_object(
      'aiActionId',v_action.id,'proposal',p_result->'proposal','evidence',p_result->'evidence','confidence',p_result->'confidence',
      'assumptions',p_result->'assumptions','executedModel',p_result->>'model','resultContractVersion',v_contract,
      'reviewStatus','pending-human-review','approvalRequired',TRUE,'proposalOnly',TRUE,'automaticMutationAllowed',FALSE,
      'externalEffectAllowed',FALSE,'modelExecuted',TRUE,'completedAt',v_now
    ),updated_at=v_now
    WHERE id=v_audit.id;
  ELSE
    UPDATE public.suite_records
    SET state='model-failed',data=data||pg_catalog.jsonb_build_object(
      'aiActionId',v_action.id,'reviewStatus','model-failed','modelError',p_result->>'error','proposalOnly',TRUE,
      'automaticMutationAllowed',FALSE,'externalEffectAllowed',FALSE,'modelCompleted',FALSE,'failedAt',v_now
    ),updated_at=v_now
    WHERE id=v_audit.id;
  END IF;

  PERFORM pg_catalog.set_config('app.workspace_id',v_action.workspace_id::TEXT,TRUE);
  RETURN TRUE;
END
$function$;

ALTER FUNCTION managed_oss_complete_suite_ai_action_v4(UUID,TEXT,JSONB,TEXT) OWNER TO managed_oss_suite_owner;
REVOKE ALL ON FUNCTION managed_oss_complete_suite_ai_action_v4(UUID,TEXT,JSONB,TEXT) FROM PUBLIC,managed_oss_runtime;
GRANT EXECUTE ON FUNCTION managed_oss_complete_suite_ai_action_v4(UUID,TEXT,JSONB,TEXT) TO managed_oss_ai;
