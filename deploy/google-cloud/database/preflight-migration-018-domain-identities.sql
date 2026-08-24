-- migration-018-domain-identity-preflight-v1
--
-- Read-only duplicate inventory for every unique index introduced by
-- 018-domain-identity-invariants.sql. The rollout invokes psql in unaligned,
-- tuples-only mode, so the only result columns are invariant_name and
-- duplicate_group_count. No tenant key value is projected by the report or returned.

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15min';
SET LOCAL search_path = pg_catalog, public;

SELECT CASE
WHEN to_regclass('public.suite_records') IS NULL THEN $missing_suite_records$
SELECT invariant_name, 0::bigint AS duplicate_group_count
FROM (VALUES
  ('suite_core_webhook_delivery_unique'),
  ('suite_core_inbox_delivery_unique'),
  ('suite_core_crm_external_key_unique'),
  ('suite_core_feedback_vote_unique'),
  ('suite_core_active_route_unique'),
  ('suite_core_link_event_unique'),
  ('suite_premium_project_key_unique'),
  ('suite_premium_stream_key_unique'),
  ('suite_premium_item_sku_unique'),
  ('suite_premium_attachment_snapshot_unique'),
  ('suite_events_payment_provider_receipt_unique'),
  ('suite_events_refund_provider_receipt_unique'),
  ('suite_events_scanner_receipt_unique'),
  ('suite_events_ticket_ordinal_unique'),
  ('suite_people_ack_subject_receipt_unique'),
  ('suite_people_leave_subject_receipt_unique'),
  ('suite_people_attendance_source_receipt_unique'),
  ('suite_people_correction_receipt_unique'),
  ('suite_people_review_cycle_unique'),
  ('suite_people_submission_receipt_unique'),
  ('suite_people_revocation_source_receipt_unique'),
  ('suite_live_consent_subject_receipt_unique'),
  ('suite_metering_source_event_unique'),
  ('suite_metering_invoice_provider_receipt_unique')
) AS invariants(invariant_name)
ORDER BY invariant_name;
$missing_suite_records$
ELSE $existing_suite_records$
SELECT 'suite_core_webhook_delivery_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'endpointId'),(data->>'deliveryId')
  FROM suite_records
  WHERE module_id='automate' AND record_type='trigger-event' AND COALESCE(data->>'endpointId','')<>'' AND COALESCE(data->>'deliveryId','')<>''
  GROUP BY workspace_id,(data->>'endpointId'),(data->>'deliveryId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_core_inbox_delivery_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'deliveryId')
  FROM suite_records
  WHERE module_id='inbox' AND record_type='message' AND COALESCE(data->>'deliveryId','')<>''
  GROUP BY workspace_id,(data->>'deliveryId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_core_crm_external_key_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'externalKey')
  FROM suite_records
  WHERE module_id='crm' AND record_type='account' AND COALESCE(data->>'externalKey','')<>''
  GROUP BY workspace_id,(data->>'externalKey')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_core_feedback_vote_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'requestId'),(data->>'voterKeyHash')
  FROM suite_records
  WHERE module_id='feedback' AND record_type='feedback-vote' AND COALESCE(data->>'requestId','')<>'' AND COALESCE(data->>'voterKeyHash','')<>''
  GROUP BY workspace_id,(data->>'requestId'),(data->>'voterKeyHash')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_core_active_route_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'routeKey')
  FROM suite_records
  WHERE module_id='links' AND record_type='link-route' AND state<>'disabled' AND COALESCE(data->>'routeKey','')<>''
  GROUP BY workspace_id,(data->>'routeKey')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_core_link_event_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'eventId')
  FROM suite_records
  WHERE module_id='links' AND record_type='link-event' AND COALESCE(data->>'eventId','')<>''
  GROUP BY workspace_id,(data->>'eventId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_premium_project_key_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'key')
  FROM suite_records
  WHERE module_id='projects' AND record_type='project' AND COALESCE(data->>'key','')<>''
  GROUP BY workspace_id,(data->>'key')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_premium_stream_key_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'key')
  FROM suite_records
  WHERE module_id='channels' AND record_type='stream' AND COALESCE(data->>'key','')<>''
  GROUP BY workspace_id,(data->>'key')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_premium_item_sku_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'sku')
  FROM suite_records
  WHERE module_id='operations' AND record_type='item' AND COALESCE(data->>'sku','')<>''
  GROUP BY workspace_id,(data->>'sku')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_premium_attachment_snapshot_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'collectionId'),(data->>'recordId'),(data->>'contentHash'),(data->>'sourceVersion'),(data->>'sourceSnapshotHash')
  FROM suite_records
  WHERE module_id='assistant' AND record_type='source-attachment' AND COALESCE(data->>'collectionId','')<>'' AND COALESCE(data->>'recordId','')<>''
  GROUP BY workspace_id,(data->>'collectionId'),(data->>'recordId'),(data->>'contentHash'),(data->>'sourceVersion'),(data->>'sourceSnapshotHash')
  HAVING COUNT(*) > 1
    AND (data->>'contentHash') IS NOT NULL
    AND (data->>'sourceVersion') IS NOT NULL
    AND (data->>'sourceSnapshotHash') IS NOT NULL
) AS duplicate_groups
UNION ALL
SELECT 'suite_events_payment_provider_receipt_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'provider'),(data->>'providerReceiptId')
  FROM suite_records
  WHERE module_id='events' AND record_type='payment-receipt' AND COALESCE(data->>'provider','')<>'' AND COALESCE(data->>'providerReceiptId','')<>''
  GROUP BY workspace_id,(data->>'provider'),(data->>'providerReceiptId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_events_refund_provider_receipt_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'provider'),(data->>'providerReceiptId')
  FROM suite_records
  WHERE module_id='events' AND record_type='refund-receipt' AND COALESCE(data->>'provider','')<>'' AND COALESCE(data->>'providerReceiptId','')<>''
  GROUP BY workspace_id,(data->>'provider'),(data->>'providerReceiptId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_events_scanner_receipt_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'scannerReceiptId')
  FROM suite_records
  WHERE module_id='events' AND record_type='check-in-receipt' AND COALESCE(data->>'scannerReceiptId','')<>''
  GROUP BY workspace_id,(data->>'scannerReceiptId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_events_ticket_ordinal_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'reservationId'),(data->>'ordinal')
  FROM suite_records
  WHERE module_id='events' AND record_type='ticket' AND COALESCE(data->>'reservationId','')<>'' AND COALESCE(data->>'ordinal','')<>''
  GROUP BY workspace_id,(data->>'reservationId'),(data->>'ordinal')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_people_ack_subject_receipt_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'subjectUserId'),(data->>'subjectReceiptId')
  FROM suite_records
  WHERE module_id='people' AND record_type='policy-acknowledgement' AND COALESCE(data->>'subjectUserId','')<>'' AND COALESCE(data->>'subjectReceiptId','')<>''
  GROUP BY workspace_id,(data->>'subjectUserId'),(data->>'subjectReceiptId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_people_leave_subject_receipt_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'subjectUserId'),(data->>'subjectReceiptId')
  FROM suite_records
  WHERE module_id='people' AND record_type='leave-request' AND COALESCE(data->>'subjectUserId','')<>'' AND COALESCE(data->>'subjectReceiptId','')<>''
  GROUP BY workspace_id,(data->>'subjectUserId'),(data->>'subjectReceiptId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_people_attendance_source_receipt_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'subjectUserId'),(data->>'sourceReceiptId')
  FROM suite_records
  WHERE module_id='people' AND record_type='attendance' AND COALESCE(data->>'subjectUserId','')<>'' AND COALESCE(data->>'sourceReceiptId','')<>''
  GROUP BY workspace_id,(data->>'subjectUserId'),(data->>'sourceReceiptId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_people_correction_receipt_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'correctionReceiptId')
  FROM suite_records
  WHERE module_id='people' AND record_type='attendance-correction' AND COALESCE(data->>'correctionReceiptId','')<>''
  GROUP BY workspace_id,(data->>'correctionReceiptId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_people_review_cycle_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'profileId'),(data->>'cycleKey')
  FROM suite_records
  WHERE module_id='people' AND record_type='people-review' AND COALESCE(data->>'profileId','')<>'' AND COALESCE(data->>'cycleKey','')<>''
  GROUP BY workspace_id,(data->>'profileId'),(data->>'cycleKey')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_people_submission_receipt_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'submittedBy'),(data->>'submissionReceiptId')
  FROM suite_records
  WHERE module_id='people' AND record_type='review-submission' AND COALESCE(data->>'submittedBy','')<>'' AND COALESCE(data->>'submissionReceiptId','')<>''
  GROUP BY workspace_id,(data->>'submittedBy'),(data->>'submissionReceiptId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_people_revocation_source_receipt_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'system'),(data->>'sourceReceiptId')
  FROM suite_records
  WHERE module_id='people' AND record_type='access-revocation-receipt' AND COALESCE(data->>'system','')<>'' AND COALESCE(data->>'sourceReceiptId','')<>''
  GROUP BY workspace_id,(data->>'system'),(data->>'sourceReceiptId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_live_consent_subject_receipt_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'participantRef'),(data->>'subjectReceiptId')
  FROM suite_records
  WHERE module_id='live' AND record_type='media-consent-receipt' AND COALESCE(data->>'participantRef','')<>'' AND COALESCE(data->>'subjectReceiptId','')<>''
  GROUP BY workspace_id,(data->>'participantRef'),(data->>'subjectReceiptId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_metering_source_event_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'sourceEventId')
  FROM suite_records
  WHERE module_id='metering' AND record_type='usage-event' AND COALESCE(data->>'sourceEventId','')<>''
  GROUP BY workspace_id,(data->>'sourceEventId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
UNION ALL
SELECT 'suite_metering_invoice_provider_receipt_unique' AS invariant_name, COUNT(*)::bigint AS duplicate_group_count
FROM (
  SELECT workspace_id,(data->>'provider'),(data->>'providerReceiptId')
  FROM suite_records
  WHERE module_id='metering' AND record_type='invoice-payment-receipt' AND COALESCE(data->>'provider','')<>'' AND COALESCE(data->>'providerReceiptId','')<>''
  GROUP BY workspace_id,(data->>'provider'),(data->>'providerReceiptId')
  HAVING COUNT(*) > 1
) AS duplicate_groups
ORDER BY invariant_name;
$existing_suite_records$
END
\gexec

ROLLBACK;
