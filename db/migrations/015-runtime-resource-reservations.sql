-- Runtime manifests now include a bounded per-application ingress proxy. Older
-- rows reserved only the upstream application services. Normalize the exact
-- verified manifest totals atomically before the new worker reconciles them.

DO $runtime_reservation_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM checkout_capacity_holds WHERE state='active')
    OR EXISTS (SELECT 1 FROM plan_capacity_change_holds WHERE state='active') THEN
    RAISE EXCEPTION 'active capacity holds must be resolved before runtime reservation normalization';
  END IF;

  IF EXISTS (
    SELECT 1 FROM application_instances
    WHERE app_id IN ('cal-diy','documenso','heyform','uptime-kuma','listmonk','umami')
      AND memory_reservation_mb IS DISTINCT FROM CASE app_id
        WHEN 'cal-diy' THEN 3072 WHEN 'documenso' THEN 2112 WHEN 'heyform' THEN 1312
        WHEN 'uptime-kuma' THEN 384 WHEN 'listmonk' THEN 576 WHEN 'umami' THEN 768 END
      AND memory_reservation_mb IS DISTINCT FROM CASE app_id
        WHEN 'cal-diy' THEN 3104 WHEN 'documenso' THEN 2144 WHEN 'heyform' THEN 1344
        WHEN 'uptime-kuma' THEN 416 WHEN 'listmonk' THEN 608 WHEN 'umami' THEN 800 END
  ) THEN
    RAISE EXCEPTION 'a verified application has an unrecognized memory reservation; reconcile it manually';
  END IF;

  IF EXISTS (
    WITH projected AS (
      SELECT worker_node_id,
        SUM(CASE app_id
          WHEN 'cal-diy' THEN 3104 WHEN 'documenso' THEN 2144 WHEN 'heyform' THEN 1344
          WHEN 'uptime-kuma' THEN 416 WHEN 'listmonk' THEN 608 WHEN 'umami' THEN 800
          ELSE memory_reservation_mb END)::BIGINT memory_mb,
        SUM(cpu_reservation_millis)::BIGINT cpu_millis,
        SUM(storage_reservation_gb)::BIGINT storage_gb
      FROM application_instances
      WHERE worker_node_id IS NOT NULL
      GROUP BY worker_node_id
    )
    SELECT 1 FROM projected p JOIN worker_nodes w ON w.id=p.worker_node_id
    WHERE p.memory_mb+w.system_reserve_memory_mb>w.capacity_memory_mb
       OR p.cpu_millis>w.capacity_cpu_millis
       OR p.storage_gb>w.capacity_storage_gb
  ) THEN
    RAISE EXCEPTION 'normalized runtime reservations do not fit a worker capacity envelope';
  END IF;

  IF EXISTS (
    WITH projected AS (
      SELECT installation_id,
        COUNT(*)::BIGINT services,
        SUM(CASE app_id
          WHEN 'cal-diy' THEN 3104 WHEN 'documenso' THEN 2144 WHEN 'heyform' THEN 1344
          WHEN 'uptime-kuma' THEN 416 WHEN 'listmonk' THEN 608 WHEN 'umami' THEN 800
          ELSE memory_reservation_mb END)::BIGINT memory_mb,
        SUM(cpu_reservation_millis)::BIGINT cpu_millis,
        SUM(storage_reservation_gb)::BIGINT storage_gb
      FROM application_instances
      GROUP BY installation_id
    )
    SELECT 1
    FROM projected p
    JOIN installation_capacity_allocations a ON a.installation_id=p.installation_id AND a.state='active'
    WHERE p.memory_mb>a.allocation_memory_mb
       OR p.cpu_millis>a.allocation_cpu_millis
       OR p.storage_gb>a.allocation_storage_gb
       OR p.services>a.allocation_max_services
  ) THEN
    RAISE EXCEPTION 'normalized runtime reservations do not fit an active paid-plan allocation';
  END IF;
END
$runtime_reservation_preflight$;

UPDATE application_instances
SET memory_reservation_mb=CASE app_id
  WHEN 'cal-diy' THEN 3104
  WHEN 'documenso' THEN 2144
  WHEN 'heyform' THEN 1344
  WHEN 'uptime-kuma' THEN 416
  WHEN 'listmonk' THEN 608
  WHEN 'umami' THEN 800
END,
updated_at=NOW()
WHERE app_id IN ('cal-diy','documenso','heyform','uptime-kuma','listmonk','umami')
  AND memory_reservation_mb IS DISTINCT FROM CASE app_id
    WHEN 'cal-diy' THEN 3104
    WHEN 'documenso' THEN 2144
    WHEN 'heyform' THEN 1344
    WHEN 'uptime-kuma' THEN 416
    WHEN 'listmonk' THEN 608
    WHEN 'umami' THEN 800
  END;
