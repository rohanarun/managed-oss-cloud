CREATE TABLE suite_storage_objects (
  record_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  module_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  object_ref TEXT NOT NULL,
  object_version TEXT NOT NULL,
  checksum_sha256 CHAR(64) NOT NULL,
  size_bytes BIGINT NOT NULL,
  accounting_version TEXT NOT NULL DEFAULT 'suite-storage-object.v1',
  accounting_state TEXT NOT NULL DEFAULT 'retained',
  size_source TEXT NOT NULL,
  object_store_verified BOOLEAN NOT NULL DEFAULT FALSE,
  object_store_observed_bytes BIGINT,
  object_store_observed_at TIMESTAMPTZ,
  verification_state TEXT NOT NULL DEFAULT 'registered-unverified',
  registered_at TIMESTAMPTZ NOT NULL,
  last_reconciled_at TIMESTAMPTZ,
  FOREIGN KEY(workspace_id,record_id) REFERENCES suite_records(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id) REFERENCES suite_workspaces(id) ON DELETE CASCADE,
  CHECK (module_id IN ('drive','esign')),
  CHECK ((module_id='drive' AND record_type='file-version') OR (module_id='esign' AND record_type='document')),
  CHECK (object_ref<>'' AND object_version<>''),
  CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (size_bytes BETWEEN 1 AND 10000000000),
  CHECK (accounting_version='suite-storage-object.v1'),
  CHECK (accounting_state='retained'),
  CHECK (size_source IN ('client-registered','object-store-head','legacy-registered-metadata')),
  CHECK (verification_state IN ('registered-unverified','verified','size-mismatch')),
  CHECK ((object_store_verified AND size_source='object-store-head' AND verification_state='verified') OR (NOT object_store_verified AND size_source<>'object-store-head' AND verification_state<>'verified')),
  CHECK (object_store_observed_bytes IS NULL OR object_store_observed_bytes>0)
);

ALTER TABLE suite_storage_objects OWNER TO managed_oss_suite_owner;
CREATE INDEX suite_storage_objects_workspace_usage_idx ON suite_storage_objects(workspace_id,accounting_state,registered_at,record_id);
CREATE INDEX suite_storage_objects_reconciliation_idx ON suite_storage_objects(object_store_verified,verification_state,last_reconciled_at,record_id);

DO $validate_legacy_storage$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM suite_records
    WHERE ((module_id='drive' AND record_type='file-version') OR (module_id='esign' AND record_type='document'))
      AND (
        state<>'immutable'
        OR pg_catalog.jsonb_typeof(data->'sizeBytes') IS DISTINCT FROM 'number'
        OR COALESCE(data->>'sizeBytes','') !~ '^[1-9][0-9]*$'
        OR (data->>'sizeBytes')::NUMERIC>10000000000
        OR CASE WHEN module_id='drive' THEN
          COALESCE(data->>'fileId','') !~ '^[0-9a-fA-F-]{36}$'
          OR COALESCE(data->>'fileVersionNumber','') !~ '^[1-9][0-9]*$'
          OR COALESCE(data->>'objectKey','')=''
          OR COALESCE(data->>'checksum','') !~ '^[a-f0-9]{64}$'
        ELSE
          COALESCE(data->>'objectRef','')=''
          OR COALESCE(data->>'objectVersion','')=''
          OR COALESCE(data->>'sha256','') !~ '^[a-f0-9]{64}$'
        END
      )
  ) THEN
    RAISE EXCEPTION 'retained Drive or e-sign object metadata is malformed; reconcile it before applying migration 014';
  END IF;
END
$validate_legacy_storage$;

UPDATE suite_records
SET data=pg_catalog.jsonb_set(
  data,
  '{storageAccounting}',
  pg_catalog.jsonb_build_object(
    'version','suite-storage-object.v1',
    'state','retained',
    'registeredBytes',(data->>'sizeBytes')::BIGINT,
    'sizeSource','legacy-registered-metadata',
    'objectStoreVerified',FALSE
  ),
  TRUE
)
WHERE (module_id='drive' AND record_type='file-version')
   OR (module_id='esign' AND record_type='document');

INSERT INTO suite_storage_objects(
  record_id,workspace_id,module_id,record_type,object_ref,object_version,checksum_sha256,size_bytes,
  size_source,object_store_verified,verification_state,registered_at
)
SELECT
  id,
  workspace_id,
  module_id,
  record_type,
  CASE WHEN module_id='drive' THEN data->>'objectKey' ELSE data->>'objectRef' END,
  CASE WHEN module_id='drive' THEN (data->>'fileId')||':'||(data->>'fileVersionNumber') ELSE data->>'objectVersion' END,
  CASE WHEN module_id='drive' THEN data->>'checksum' ELSE data->>'sha256' END,
  (data->>'sizeBytes')::BIGINT,
  'legacy-registered-metadata',
  FALSE,
  'registered-unverified',
  created_at
FROM suite_records
WHERE (module_id='drive' AND record_type='file-version')
   OR (module_id='esign' AND record_type='document');

CREATE OR REPLACE FUNCTION managed_oss_register_suite_storage_object()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
DECLARE
  v_object_ref TEXT;
  v_object_version TEXT;
  v_checksum TEXT;
  v_size_bytes BIGINT;
  v_size_source TEXT;
  v_verified BOOLEAN;
BEGIN
  IF NOT ((NEW.module_id='drive' AND NEW.record_type='file-version') OR (NEW.module_id='esign' AND NEW.record_type='document')) THEN
    RETURN NEW;
  END IF;
  IF NEW.state<>'immutable'
    OR pg_catalog.jsonb_typeof(NEW.data->'sizeBytes') IS DISTINCT FROM 'number'
    OR COALESCE(NEW.data->>'sizeBytes','') !~ '^[1-9][0-9]*$'
    OR (NEW.data->>'sizeBytes')::NUMERIC>10000000000
    OR pg_catalog.jsonb_typeof(NEW.data->'storageAccounting') IS DISTINCT FROM 'object'
    OR NEW.data->'storageAccounting'->>'version' IS DISTINCT FROM 'suite-storage-object.v1'
    OR NEW.data->'storageAccounting'->>'state' IS DISTINCT FROM 'retained'
    OR NEW.data->'storageAccounting'->>'registeredBytes' IS DISTINCT FROM NEW.data->>'sizeBytes'
    OR NEW.data->'storageAccounting'->>'sizeSource' NOT IN ('client-registered','object-store-head','legacy-registered-metadata')
    OR pg_catalog.jsonb_typeof(NEW.data->'storageAccounting'->'objectStoreVerified') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'retained object metadata does not satisfy suite-storage-object.v1';
  END IF;

  v_size_bytes := (NEW.data->>'sizeBytes')::BIGINT;
  v_size_source := NEW.data->'storageAccounting'->>'sizeSource';
  v_verified := (NEW.data->'storageAccounting'->>'objectStoreVerified')::BOOLEAN;
  IF (v_verified AND v_size_source<>'object-store-head') OR (NOT v_verified AND v_size_source='object-store-head') THEN
    RAISE EXCEPTION 'retained object verification source is inconsistent';
  END IF;

  IF NEW.module_id='drive' THEN
    IF COALESCE(NEW.data->>'fileId','') !~ '^[0-9a-fA-F-]{36}$'
      OR COALESCE(NEW.data->>'fileVersionNumber','') !~ '^[1-9][0-9]*$'
      OR COALESCE(NEW.data->>'objectKey','')=''
      OR COALESCE(NEW.data->>'checksum','') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'retained Drive object metadata is malformed';
    END IF;
    v_object_ref := NEW.data->>'objectKey';
    v_object_version := (NEW.data->>'fileId')||':'||(NEW.data->>'fileVersionNumber');
    v_checksum := NEW.data->>'checksum';
  ELSE
    IF COALESCE(NEW.data->>'objectRef','')=''
      OR COALESCE(NEW.data->>'objectVersion','')=''
      OR COALESCE(NEW.data->>'sha256','') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'retained e-sign object metadata is malformed';
    END IF;
    v_object_ref := NEW.data->>'objectRef';
    v_object_version := NEW.data->>'objectVersion';
    v_checksum := NEW.data->>'sha256';
  END IF;

  INSERT INTO public.suite_storage_objects(
    record_id,workspace_id,module_id,record_type,object_ref,object_version,checksum_sha256,size_bytes,
    size_source,object_store_verified,verification_state,registered_at
  ) VALUES (
    NEW.id,NEW.workspace_id,NEW.module_id,NEW.record_type,v_object_ref,v_object_version,v_checksum,v_size_bytes,
    v_size_source,v_verified,CASE WHEN v_verified THEN 'verified' ELSE 'registered-unverified' END,NEW.created_at
  );
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION managed_oss_protect_suite_storage_record()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
BEGIN
  IF TG_OP='DELETE' AND ((OLD.module_id='drive' AND OLD.record_type='file-version') OR (OLD.module_id='esign' AND OLD.record_type='document')) THEN
    RAISE EXCEPTION 'retained object metadata cannot be deleted before an audited object-store release';
  END IF;
  IF TG_OP='UPDATE' AND (
    (OLD.module_id='drive' AND OLD.record_type='file-version')
    OR (OLD.module_id='esign' AND OLD.record_type='document')
    OR (NEW.module_id='drive' AND NEW.record_type='file-version')
    OR (NEW.module_id='esign' AND NEW.record_type='document')
  ) AND ROW(NEW.module_id,NEW.record_type,NEW.title,NEW.state,NEW.data) IS DISTINCT FROM ROW(OLD.module_id,OLD.record_type,OLD.title,OLD.state,OLD.data) THEN
    RAISE EXCEPTION 'retained object metadata is immutable; create a new object-version record';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END
$function$;

CREATE OR REPLACE FUNCTION managed_oss_protect_suite_storage_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'suite storage accounting rows are immutable';
  END IF;
  IF pg_catalog.current_setting('app.suite_storage_reconciliation',TRUE) IS DISTINCT FROM 'managed-reconcile-v1' THEN
    RAISE EXCEPTION 'suite storage accounting changes require the managed reconciliation function';
  END IF;
  IF ROW(NEW.record_id,NEW.workspace_id,NEW.module_id,NEW.record_type,NEW.object_ref,NEW.object_version,NEW.checksum_sha256,NEW.size_bytes,NEW.accounting_version,NEW.accounting_state,NEW.registered_at)
    IS DISTINCT FROM
    ROW(OLD.record_id,OLD.workspace_id,OLD.module_id,OLD.record_type,OLD.object_ref,OLD.object_version,OLD.checksum_sha256,OLD.size_bytes,OLD.accounting_version,OLD.accounting_state,OLD.registered_at) THEN
    RAISE EXCEPTION 'suite storage identity and registered bytes are immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION managed_oss_reconcile_suite_storage_object(
  p_record_id UUID,
  p_observed_bytes BIGINT,
  p_observed_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
DECLARE
  v_registered_bytes BIGINT;
BEGIN
  IF p_record_id IS NULL OR p_observed_bytes IS NULL OR p_observed_bytes<1 OR p_observed_at IS NULL OR p_observed_at>pg_catalog.now()+INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'invalid suite storage reconciliation evidence';
  END IF;
  SELECT size_bytes INTO v_registered_bytes
  FROM public.suite_storage_objects
  WHERE record_id=p_record_id
  FOR UPDATE;
  IF v_registered_bytes IS NULL THEN RETURN FALSE; END IF;
  PERFORM pg_catalog.set_config('app.suite_storage_reconciliation','managed-reconcile-v1',TRUE);
  UPDATE public.suite_storage_objects
  SET object_store_observed_bytes=p_observed_bytes,
      object_store_observed_at=p_observed_at,
      object_store_verified=(p_observed_bytes=v_registered_bytes),
      size_source=CASE WHEN p_observed_bytes=v_registered_bytes THEN 'object-store-head' ELSE 'client-registered' END,
      verification_state=CASE WHEN p_observed_bytes=v_registered_bytes THEN 'verified' ELSE 'size-mismatch' END,
      last_reconciled_at=pg_catalog.now()
  WHERE record_id=p_record_id;
  RETURN TRUE;
END
$function$;

ALTER FUNCTION managed_oss_register_suite_storage_object() OWNER TO managed_oss_suite_owner;
ALTER FUNCTION managed_oss_protect_suite_storage_record() OWNER TO managed_oss_suite_owner;
ALTER FUNCTION managed_oss_protect_suite_storage_ledger() OWNER TO managed_oss_suite_owner;
ALTER FUNCTION managed_oss_reconcile_suite_storage_object(UUID,BIGINT,TIMESTAMPTZ) OWNER TO managed_oss_suite_owner;

CREATE TRIGGER suite_storage_object_register
AFTER INSERT ON suite_records
FOR EACH ROW EXECUTE FUNCTION managed_oss_register_suite_storage_object();

CREATE TRIGGER suite_storage_record_immutable
BEFORE UPDATE OR DELETE ON suite_records
FOR EACH ROW EXECUTE FUNCTION managed_oss_protect_suite_storage_record();

CREATE TRIGGER suite_storage_ledger_immutable
BEFORE UPDATE OR DELETE ON suite_storage_objects
FOR EACH ROW EXECUTE FUNCTION managed_oss_protect_suite_storage_ledger();

CREATE POLICY suite_storage_objects_tenant ON suite_storage_objects
  FOR SELECT TO managed_oss_runtime
  USING (workspace_id=NULLIF(pg_catalog.current_setting('app.workspace_id',TRUE),'')::UUID);
CREATE POLICY suite_storage_objects_owner ON suite_storage_objects
  FOR ALL TO managed_oss_suite_owner,managed_oss_migrator
  USING (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member'))
  WITH CHECK (pg_catalog.pg_has_role(CURRENT_USER,'managed_oss_suite_owner','member'));

ALTER TABLE suite_storage_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE suite_storage_objects FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE suite_storage_objects FROM PUBLIC,managed_oss_runtime,managed_oss_ai,managed_oss_control;
GRANT SELECT ON TABLE suite_storage_objects TO managed_oss_runtime;
REVOKE ALL ON FUNCTION managed_oss_register_suite_storage_object(),managed_oss_protect_suite_storage_record(),managed_oss_protect_suite_storage_ledger(),managed_oss_reconcile_suite_storage_object(UUID,BIGINT,TIMESTAMPTZ) FROM PUBLIC,managed_oss_runtime,managed_oss_ai,managed_oss_control;
GRANT EXECUTE ON FUNCTION managed_oss_reconcile_suite_storage_object(UUID,BIGINT,TIMESTAMPTZ) TO managed_oss_control;
