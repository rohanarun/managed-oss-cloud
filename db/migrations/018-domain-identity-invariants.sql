-- Exact domain identities that must remain unique even when a workspace grows
-- beyond an engine's bounded in-process scan. The predicates exclude legacy
-- rows that predate the identity field instead of collapsing every NULL/blank.

CREATE UNIQUE INDEX IF NOT EXISTS suite_core_webhook_delivery_unique
  ON suite_records(workspace_id,(data->>'endpointId'),(data->>'deliveryId'))
  WHERE module_id='automate' AND record_type='trigger-event' AND COALESCE(data->>'endpointId','')<>'' AND COALESCE(data->>'deliveryId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_core_inbox_delivery_unique
  ON suite_records(workspace_id,(data->>'deliveryId'))
  WHERE module_id='inbox' AND record_type='message' AND COALESCE(data->>'deliveryId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_core_crm_external_key_unique
  ON suite_records(workspace_id,(data->>'externalKey'))
  WHERE module_id='crm' AND record_type='account' AND COALESCE(data->>'externalKey','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_core_feedback_vote_unique
  ON suite_records(workspace_id,(data->>'requestId'),(data->>'voterKeyHash'))
  WHERE module_id='feedback' AND record_type='feedback-vote' AND COALESCE(data->>'requestId','')<>'' AND COALESCE(data->>'voterKeyHash','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_core_active_route_unique
  ON suite_records(workspace_id,(data->>'routeKey'))
  WHERE module_id='links' AND record_type='link-route' AND state<>'disabled' AND COALESCE(data->>'routeKey','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_core_link_event_unique
  ON suite_records(workspace_id,(data->>'eventId'))
  WHERE module_id='links' AND record_type='link-event' AND COALESCE(data->>'eventId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_premium_project_key_unique
  ON suite_records(workspace_id,(data->>'key'))
  WHERE module_id='projects' AND record_type='project' AND COALESCE(data->>'key','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_premium_stream_key_unique
  ON suite_records(workspace_id,(data->>'key'))
  WHERE module_id='channels' AND record_type='stream' AND COALESCE(data->>'key','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_premium_item_sku_unique
  ON suite_records(workspace_id,(data->>'sku'))
  WHERE module_id='operations' AND record_type='item' AND COALESCE(data->>'sku','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_premium_attachment_snapshot_unique
  ON suite_records(workspace_id,(data->>'collectionId'),(data->>'recordId'),(data->>'contentHash'),(data->>'sourceVersion'),(data->>'sourceSnapshotHash'))
  WHERE module_id='assistant' AND record_type='source-attachment' AND COALESCE(data->>'collectionId','')<>'' AND COALESCE(data->>'recordId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_events_payment_provider_receipt_unique
  ON suite_records(workspace_id,(data->>'provider'),(data->>'providerReceiptId'))
  WHERE module_id='events' AND record_type='payment-receipt' AND COALESCE(data->>'provider','')<>'' AND COALESCE(data->>'providerReceiptId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_events_refund_provider_receipt_unique
  ON suite_records(workspace_id,(data->>'provider'),(data->>'providerReceiptId'))
  WHERE module_id='events' AND record_type='refund-receipt' AND COALESCE(data->>'provider','')<>'' AND COALESCE(data->>'providerReceiptId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_events_scanner_receipt_unique
  ON suite_records(workspace_id,(data->>'scannerReceiptId'))
  WHERE module_id='events' AND record_type='check-in-receipt' AND COALESCE(data->>'scannerReceiptId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_events_ticket_ordinal_unique
  ON suite_records(workspace_id,(data->>'reservationId'),(data->>'ordinal'))
  WHERE module_id='events' AND record_type='ticket' AND COALESCE(data->>'reservationId','')<>'' AND COALESCE(data->>'ordinal','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_people_ack_subject_receipt_unique
  ON suite_records(workspace_id,(data->>'subjectUserId'),(data->>'subjectReceiptId'))
  WHERE module_id='people' AND record_type='policy-acknowledgement' AND COALESCE(data->>'subjectUserId','')<>'' AND COALESCE(data->>'subjectReceiptId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_people_leave_subject_receipt_unique
  ON suite_records(workspace_id,(data->>'subjectUserId'),(data->>'subjectReceiptId'))
  WHERE module_id='people' AND record_type='leave-request' AND COALESCE(data->>'subjectUserId','')<>'' AND COALESCE(data->>'subjectReceiptId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_people_attendance_source_receipt_unique
  ON suite_records(workspace_id,(data->>'subjectUserId'),(data->>'sourceReceiptId'))
  WHERE module_id='people' AND record_type='attendance' AND COALESCE(data->>'subjectUserId','')<>'' AND COALESCE(data->>'sourceReceiptId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_people_correction_receipt_unique
  ON suite_records(workspace_id,(data->>'correctionReceiptId'))
  WHERE module_id='people' AND record_type='attendance-correction' AND COALESCE(data->>'correctionReceiptId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_people_review_cycle_unique
  ON suite_records(workspace_id,(data->>'profileId'),(data->>'cycleKey'))
  WHERE module_id='people' AND record_type='people-review' AND COALESCE(data->>'profileId','')<>'' AND COALESCE(data->>'cycleKey','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_people_submission_receipt_unique
  ON suite_records(workspace_id,(data->>'submittedBy'),(data->>'submissionReceiptId'))
  WHERE module_id='people' AND record_type='review-submission' AND COALESCE(data->>'submittedBy','')<>'' AND COALESCE(data->>'submissionReceiptId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_people_revocation_source_receipt_unique
  ON suite_records(workspace_id,(data->>'system'),(data->>'sourceReceiptId'))
  WHERE module_id='people' AND record_type='access-revocation-receipt' AND COALESCE(data->>'system','')<>'' AND COALESCE(data->>'sourceReceiptId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_live_consent_subject_receipt_unique
  ON suite_records(workspace_id,(data->>'participantRef'),(data->>'subjectReceiptId'))
  WHERE module_id='live' AND record_type='media-consent-receipt' AND COALESCE(data->>'participantRef','')<>'' AND COALESCE(data->>'subjectReceiptId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_metering_source_event_unique
  ON suite_records(workspace_id,(data->>'sourceEventId'))
  WHERE module_id='metering' AND record_type='usage-event' AND COALESCE(data->>'sourceEventId','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS suite_metering_invoice_provider_receipt_unique
  ON suite_records(workspace_id,(data->>'provider'),(data->>'providerReceiptId'))
  WHERE module_id='metering' AND record_type='invoice-payment-receipt' AND COALESCE(data->>'provider','')<>'' AND COALESCE(data->>'providerReceiptId','')<>'';
