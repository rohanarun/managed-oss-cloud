DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM custom_domains WHERE application_instance_id IS NULL) THEN
    RAISE EXCEPTION 'custom_domains contains rows without an application instance; repair ownership before applying migration 004';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT pg_catalog.lower(pg_catalog.rtrim(domain,'.')) AS hostname FROM custom_domains
      UNION ALL
      SELECT pg_catalog.lower(pg_catalog.rtrim(domain,'.')) AS hostname FROM suite_custom_domains
    ) existing
    GROUP BY hostname
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'a hostname is claimed by more than one pre-migration domain surface';
  END IF;
END
$preflight$;

UPDATE custom_domains SET domain=pg_catalog.lower(pg_catalog.rtrim(domain,'.')) WHERE domain<>pg_catalog.lower(pg_catalog.rtrim(domain,'.'));
UPDATE suite_custom_domains SET domain=pg_catalog.lower(pg_catalog.rtrim(domain,'.')) WHERE domain<>pg_catalog.lower(pg_catalog.rtrim(domain,'.'));

CREATE TABLE global_hostname_claims (
  id UUID PRIMARY KEY,
  hostname TEXT NOT NULL UNIQUE,
  surface TEXT NOT NULL,
  owner_user_id UUID NOT NULL,
  resource_id UUID NOT NULL,
  challenge_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  tombstoned_at TIMESTAMPTZ,
  CHECK (hostname=pg_catalog.lower(hostname) AND hostname=pg_catalog.rtrim(hostname,'.')),
  CHECK (surface IN ('application','suite')),
  CHECK (status IN ('pending','verified','active','tombstoned')),
  CHECK (challenge_token ~ '^[a-f0-9]{32,64}$'),
  CHECK ((status='tombstoned')=(tombstoned_at IS NOT NULL))
);
CREATE INDEX global_hostname_claims_owner_idx ON global_hostname_claims(owner_user_id,surface,resource_id);

ALTER TABLE custom_domains ADD COLUMN hostname_claim_id UUID;
ALTER TABLE suite_custom_domains ADD COLUMN hostname_claim_id UUID;

WITH source AS (
  SELECT
    pg_catalog.gen_random_uuid() AS claim_id,
    d.domain AS hostname,
    'application'::TEXT AS surface,
    i.user_id AS owner_user_id,
    d.application_instance_id AS resource_id,
    pg_catalog.replace(pg_catalog.gen_random_uuid()::TEXT,'-','') AS challenge_token,
    CASE WHEN d.verification_status IN ('verified','active') THEN d.verification_status ELSE 'pending' END AS status,
    d.created_at,
    d.last_checked_at
  FROM custom_domains d
  JOIN installations i ON i.id=d.installation_id
), inserted AS (
  INSERT INTO global_hostname_claims(id,hostname,surface,owner_user_id,resource_id,challenge_token,status,created_at,last_checked_at,verified_at)
  SELECT claim_id,hostname,surface,owner_user_id,resource_id,challenge_token,status,created_at,last_checked_at,
    CASE WHEN status IN ('verified','active') THEN COALESCE(last_checked_at,created_at) END
  FROM source
  RETURNING id,hostname
)
UPDATE custom_domains d SET hostname_claim_id=inserted.id FROM inserted WHERE inserted.hostname=d.domain;

WITH source AS (
  SELECT
    pg_catalog.gen_random_uuid() AS claim_id,
    d.domain AS hostname,
    'suite'::TEXT AS surface,
    w.user_id AS owner_user_id,
    d.workspace_id AS resource_id,
    pg_catalog.replace(pg_catalog.gen_random_uuid()::TEXT,'-','') AS challenge_token,
    CASE WHEN d.status IN ('verified','active') THEN d.status ELSE 'pending' END AS status,
    d.created_at,
    d.last_checked_at
  FROM suite_custom_domains d
  JOIN suite_workspaces w ON w.id=d.workspace_id
), inserted AS (
  INSERT INTO global_hostname_claims(id,hostname,surface,owner_user_id,resource_id,challenge_token,status,created_at,last_checked_at,verified_at)
  SELECT claim_id,hostname,surface,owner_user_id,resource_id,challenge_token,status,created_at,last_checked_at,
    CASE WHEN status IN ('verified','active') THEN COALESCE(last_checked_at,created_at) END
  FROM source
  RETURNING id,hostname
)
UPDATE suite_custom_domains d SET hostname_claim_id=inserted.id FROM inserted WHERE inserted.hostname=d.domain;

ALTER TABLE custom_domains ALTER COLUMN hostname_claim_id SET NOT NULL;
ALTER TABLE suite_custom_domains ALTER COLUMN hostname_claim_id SET NOT NULL;
ALTER TABLE custom_domains ADD CONSTRAINT custom_domains_hostname_claim_id_key UNIQUE(hostname_claim_id);
ALTER TABLE suite_custom_domains ADD CONSTRAINT suite_custom_domains_hostname_claim_id_key UNIQUE(hostname_claim_id);
ALTER TABLE custom_domains ADD CONSTRAINT custom_domains_hostname_claim_id_fkey FOREIGN KEY(hostname_claim_id) REFERENCES global_hostname_claims(id) ON DELETE RESTRICT;
ALTER TABLE suite_custom_domains ADD CONSTRAINT suite_custom_domains_hostname_claim_id_fkey FOREIGN KEY(hostname_claim_id) REFERENCES global_hostname_claims(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION managed_oss_enforce_hostname_claim_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $function$
BEGIN
  IF NEW.id<>OLD.id OR NEW.hostname<>OLD.hostname OR NEW.surface<>OLD.surface OR NEW.owner_user_id<>OLD.owner_user_id OR NEW.resource_id<>OLD.resource_id OR NEW.challenge_token<>OLD.challenge_token OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'hostname claim identity and challenge are immutable';
  END IF;
  IF OLD.status='tombstoned' AND NEW.status<>'tombstoned' THEN
    RAISE EXCEPTION 'tombstoned hostname claims cannot be revived';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER global_hostname_claims_immutable
BEFORE UPDATE ON global_hostname_claims
FOR EACH ROW EXECUTE FUNCTION managed_oss_enforce_hostname_claim_immutability();

CREATE OR REPLACE FUNCTION managed_oss_tombstone_hostname_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
BEGIN
  UPDATE public.global_hostname_claims
  SET status='tombstoned',tombstoned_at=COALESCE(tombstoned_at,pg_catalog.now()),last_checked_at=pg_catalog.now()
  WHERE id=OLD.hostname_claim_id;
  RETURN OLD;
END
$function$;

CREATE TRIGGER custom_domains_tombstone_claim
AFTER DELETE ON custom_domains
FOR EACH ROW EXECUTE FUNCTION managed_oss_tombstone_hostname_claim();
CREATE TRIGGER suite_custom_domains_tombstone_claim
AFTER DELETE ON suite_custom_domains
FOR EACH ROW EXECUTE FUNCTION managed_oss_tombstone_hostname_claim();

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
  JOIN public.global_hostname_claims c
    ON c.id=d.hostname_claim_id AND c.hostname=d.domain AND c.surface='suite' AND c.resource_id=d.workspace_id
  JOIN public.suite_workspaces w ON w.id=d.workspace_id
  WHERE d.domain=p_domain
    AND d.status IN ('verified','active')
    AND c.status IN ('verified','active')
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
  JOIN public.global_hostname_claims c
    ON c.id=d.hostname_claim_id AND c.hostname=d.domain AND c.surface='suite' AND c.resource_id=d.workspace_id
  JOIN public.suite_workspaces w ON w.id=d.workspace_id
  WHERE d.status IN ('verified','active') AND c.status IN ('verified','active') AND (p_unrestricted OR w.plan<>'none')
  ORDER BY d.domain
$function$;

ALTER TABLE global_hostname_claims OWNER TO managed_oss_suite_owner;
ALTER FUNCTION managed_oss_enforce_hostname_claim_immutability() OWNER TO managed_oss_suite_owner;
ALTER FUNCTION managed_oss_tombstone_hostname_claim() OWNER TO managed_oss_suite_owner;
REVOKE ALL ON TABLE global_hostname_claims FROM PUBLIC;
REVOKE ALL ON FUNCTION managed_oss_enforce_hostname_claim_immutability(),managed_oss_tombstone_hostname_claim() FROM PUBLIC;
GRANT SELECT,INSERT ON TABLE global_hostname_claims TO managed_oss_runtime;
GRANT UPDATE(status,last_checked_at,verified_at,tombstoned_at) ON TABLE global_hostname_claims TO managed_oss_runtime;
