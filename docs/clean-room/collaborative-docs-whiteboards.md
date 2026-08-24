# Collaborative documents and whiteboards module

## Product definition

| Field | Value |
| --- | --- |
| Module ID | `collab` |
| Working category | Real-time documents, canvases, and visual collaboration |
| Minimum hosted plan | Starter, $7/month |
| Scale guidance | Scale for many concurrent editors, large canvases, media assets, or extended revision history |
| License target | Original first-party source under MIT |
| Primary outcome | A team can co-edit durable documents and visual canvases, work through temporary disconnection, share controlled views, and use AI without surrendering authorship or history. |

The module combines two original content types behind one collaboration, permissions, revision, export, CLI, and MCP contract. It does not copy the appearance or interaction design of a reference editor.

## Public behavioral research record

- [Excalidraw public repository and README](https://github.com/excalidraw/excalidraw) describes an infinite canvas, drawing tools, images, localization, open JSON export, offline use, real-time collaboration, encryption, and shareable links.
- [Excalidraw MIT license](https://github.com/excalidraw/excalidraw/blob/master/LICENSE) is the official upstream license record.
- [Etherpad public repository and README](https://github.com/ether/etherpad) describes a real-time collaborative document editor with deployable server software and extension support.
- [Etherpad Apache-2.0 license](https://github.com/ether/etherpad/blob/develop/LICENSE) is the official upstream license record.

No Excalidraw or Etherpad source, protocol, operation format, schema, algorithm implementation, UI, keyboard map, visual style, copy, tests, examples, icons, or assets may be copied. If a general-purpose collaboration library is selected, it receives an independent license/provenance audit and its native format is not exposed as this module's durable public contract.

## Clean-room boundary

### Permitted inputs

- The external behaviors summarized in this specification.
- Browser, WebSocket, WebRTC, IndexedDB, accessibility, cryptography, image, and document-format standards.
- Independently reviewed permissive text-editing, canvas, CRDT, presence, and export libraries.
- Customer-created content, templates, media, and brand assets.

### Prohibited inputs

- Reference source or generated bundles, collaboration operations, document/canvas JSON shape, database design, tests, UI layout, styles, icons, shortcuts, templates, or sample libraries.
- Importing a reference product's native format by copying its implementation. Any compatibility importer requires separate format/legal review and fixture provenance.
- Silent AI edits, undeclared model-authored content, or sharing private content through model context.

## Actors and permissions

| Actor | Capabilities |
| --- | --- |
| Workspace owner | Manage retention, members, templates, public-sharing policy, exports, and deletion. |
| Editor | Create and edit assigned documents/canvases, comments, links, and assets. |
| Commenter | Read and comment without changing canonical content. |
| Viewer | Read the current allowed version. |
| Public-link viewer | Read one explicitly published snapshot or current view according to link policy. |
| Automation actor | Perform scoped structured edits with attribution and version preconditions. |
| Collaboration relay | Exchange authorized operations and presence without broad workspace access. |

Public sharing, permission changes, history truncation, permanent deletion, and broad export are privileged. Presence never grants content permission.

## Original data requirements

The implementation owns a PostgreSQL schema named `collab`. Large immutable assets and optional compacted state blobs use workspace-scoped object storage.

### `space`

- Workspace-scoped container with name, description, default permissions, retention, and optional links to projects/knowledge.

### `document`

- Space, original title, current revision, lifecycle state, language, owner, permission policy, and optional template/source links.
- States: `draft`, `active`, `archived`, `deletion_pending`, `deleted`.

### `document_block`

- Stable block identifier, semantic type, validated structured content, position/order relation, attributes, and current logical version.
- Initial types include paragraph, heading, list, checklist, quote, code, table, callout, divider, attachment, embed, and cross-module record link.
- Embeds are allowlisted structured references, never arbitrary executable markup.

### `canvas`

- Space, original title, current revision, lifecycle state, coordinate bounds, theme metadata, permission policy, and optional template links.

### `canvas_element`

- Stable element identifier, semantic type, geometry, stacking order, safe style properties, text/content, links, bindings, asset references, and current logical version.
- Initial types include rectangle, ellipse, diamond, line, arrow, freehand path, text, sticky note, frame, image, and cross-module record link.
- Coordinates and numeric fields have finite bounds; malformed or excessive geometry is rejected.

### `collaboration_operation`

- Resource, client/actor, unique operation ID, base clock/version, validated operation payload, receive time, logical clock, and persistence state.
- The public operation envelope is original and versioned.
- Operations are append-only until a verified compaction checkpoint makes older operations eligible for retention deletion.

### `revision`

- Resource, parent revision(s), content hash, compacted snapshot reference, operation clock, creator/reason, AI attribution, and timestamp.
- Named revisions are immutable and restorable by creating a new head, not rewriting history.

### `presence_session`

- Ephemeral authorized resource/user/session, display metadata, cursor/selection/viewport projection, last heartbeat, and expiration.
- Presence is not part of durable content exports and contains no secret content beyond the minimum collaboration projection.

### `comment_thread` and `comment`

- Resource anchor, participants, body, mentions, state, creation/edit history, resolution, and permission projection.
- Resolved threads remain auditable until retention permits deletion.

### `asset`

- Workspace, immutable object hash, media type, dimensions/size, scan state, creator, derived previews, and retention.
- Assets are never globally deduplicated in a way that leaks cross-workspace existence.

### `share_link`

- Resource, pinned revision or current-view mode, permission, opaque token hash, expiration, password/auth option, watermark/download policy, and revocation.

### `template`

- Workspace-authored document/canvas seed, version, preview asset, permissions, and lifecycle state.

### `export_job`

- Resource/revision, requested format/options, state, output object/hash, actor, error class, and expiration.
- Initial formats: versioned canonical JSON plus PDF for documents/canvases, Markdown/HTML for documents, and PNG/SVG for canvases where supported.

## Required workflows

### 1. Create and edit a document

1. An editor creates a blank resource or applies a workspace-owned template.
2. Local edits produce validated original operations with actor and base clock.
3. The client optimistically renders and queues unacknowledged operations durably.
4. The server authorizes, validates, orders/merges, persists, and acknowledges operations.
5. All connected clients converge on the same content hash.

### 2. Create and edit a canvas

1. An editor creates elements through accessible tools and keyboard alternatives.
2. Move, resize, text, style, binding, ordering, grouping, and deletion operations are validated independently.
3. Concurrent non-conflicting edits merge; conflicting edits resolve predictably without dropping an operation silently.
4. Large assets upload separately and enter the canvas only after scan and authorization.

### 3. Work offline and reconnect

1. An authenticated client stores its last acknowledged clock and pending operations locally.
2. Offline edits remain visibly pending and survive tab/application restart.
3. Reconnect reauthorizes access, exchanges clocks, uploads each operation idempotently, and receives missing operations/snapshot.
4. Revoked users cannot upload pending operations; the client offers a local export rather than discarding work.

### 4. Comment and mention

1. A permitted actor anchors a thread to a stable block, element, or resource location.
2. Mentions resolve workspace members and invoke the notification module through an outbox event.
3. Editing/resolving is permission-checked and audited.
4. Deleted anchors preserve an orphaned-thread history until reviewed or expired.

### 5. Create, compare, and restore revisions

1. Autosave checkpoints compact operations at bounded intervals.
2. Users may create named revisions with a reason.
3. Compare identifies semantic block/element changes and authors without relying solely on rendered text.
4. Restore creates a new revision whose source points to the historical revision; history is never rewritten.

### 6. Share

1. An authorized actor selects current-view or pinned-revision behavior, permission, expiration, and download policy.
2. Public-link requests receive only the selected resource projection.
3. Revocation is immediate at the authorization layer and edge caches.
4. Public viewers never receive presence, comments, private history, workspace search, or unrelated asset URLs unless explicitly included.

### 7. Export and import

1. Export pins an exact revision and reports format support/limits before queueing.
2. Generated output is content-addressed and linked to the revision.
3. Canonical JSON round-trips every supported semantic element and attribution field.
4. Initial import supports this module's own versioned JSON and safe Markdown/HTML text subsets; unsupported content is reported, not silently dropped.

### 8. AI-assisted work

1. A user selects an explicit resource/range and asks for a draft, summary, rewrite, diagram, or task extraction.
2. The module creates a read snapshot and redacted model projection.
3. AI returns a structured proposed patch plus explanation and source revision.
4. The UI displays a semantic diff.
5. User acceptance applies the patch with optimistic version checks and AI attribution; stale patches require regeneration or explicit rebase review.

## AI contract

### Allowed AI actions

- Draft document blocks or canvas elements from a user request.
- Summarize an exact revision or selected range.
- Propose rewrites, translations, diagrams, meeting artifacts, comments, or task extraction.
- Explain revision differences and identify unresolved comments.
- Suggest cross-module links using authorized records.

### Forbidden AI actions

- Apply edits, resolve comments, share, publish, change permissions, or delete without explicit approval.
- Read a resource merely because it has an opaque URL; normal workspace/share authorization always applies.
- Send hidden comments, prior revisions, deleted content, private assets, or other workspace records unless explicitly selected and authorized.
- Generate unsupported claims of authorship or remove AI attribution from accepted content.
- Execute embedded code, arbitrary HTML, URLs, or file paths returned by a model.

Proposed patches are typed operations validated by the same server path as human edits. Model text is never treated as executable editor state.

## HTTP, CLI, and MCP surface

Representative CLI commands:

```sh
supersuite collab document create --space SPACE_ID --title "Project brief"
supersuite collab document export --document DOCUMENT_ID --format markdown --revision REVISION_ID
supersuite collab canvas create --space SPACE_ID --title "Customer journey"
supersuite collab revision create --resource RESOURCE_ID --reason "Approved workshop"
supersuite collab compare --resource RESOURCE_ID --from REV_A --to REV_B
supersuite collab share create --resource RESOURCE_ID --revision REV_ID --permission view --expires-at 2026-09-01T00:00:00Z
supersuite collab ai propose --resource RESOURCE_ID --selection selection.json --goal "Turn these notes into tasks"
```

Required MCP tools:

- `collab_space_list`
- `collab_document_get`
- `collab_document_create`
- `collab_canvas_get`
- `collab_canvas_create`
- `collab_patch_propose`
- `collab_patch_apply`
- `collab_comment_create`
- `collab_revision_list`
- `collab_revision_compare`
- `collab_revision_restore`
- `collab_share_create`
- `collab_export_create`

MCP operates on structured blocks/elements and versioned proposed patches, not raw CRDT internals. `collab_patch_apply`, restore, share, and export require exact resource/revision versions and mutation scopes.

## Resource and plan contract

- Starter supports ordinary small-team documents/canvases, low concurrency, and assets within pooled quotas.
- Scale is recommended for many simultaneous editors, large canvases/media, high operation volume, or extended history.
- Fleet may be needed for very large organizations or AI/media processing, but no collaboration feature is source-code gated.
- WebSocket, operation, asset, export, and AI workloads have separate backpressure so export/rendering cannot starve edit persistence.

## Security and operational requirements

- Every WebSocket connection authenticates workspace, resource, role, and permission; authorization is rechecked on membership/permission change and reconnect.
- Operation IDs are workspace/resource bound, size limited, schema validated, idempotent, and rate limited.
- Asset upload/download prevents path traversal, unsafe content types, SSRF, malware, and cross-workspace hash probing.
- Rich text and embeds use a strict safe schema with contextual output escaping and CSP.
- Public links store only token hashes and can be revoked immediately.
- Operation log plus checkpoint hash proves recovery; compaction never precedes verified snapshot durability and backup coverage.
- Presence expires rapidly and is not used as proof that content is saved.

## Behavioral acceptance tests

| ID | Black-box behavior |
| --- | --- |
| COL-001 | Two workspaces create resources and assets with identical titles/content hashes; no web, HTTP, WebSocket, CLI, MCP, share, search, or object path crosses the workspace boundary. |
| COL-002 | Two authorized clients concurrently edit different document blocks; after message reordering and reconnect both converge to the same canonical content hash with both edits present. |
| COL-003 | Two clients concurrently edit the same text range; the documented merge behavior converges deterministically and neither accepted operation disappears without visible conflict/history. |
| COL-004 | An offline client queues edits, restarts, reconnects, and uploads them exactly once; all clients converge and operation attribution is preserved. |
| COL-005 | A user's access is revoked while offline; reconnect rejects pending server mutation but offers an authorized local export without exposing later remote edits. |
| COL-006 | Concurrent canvas move, text, and ordering operations converge to one finite, schema-valid element state on every client. |
| COL-007 | Malformed geometry, executable embed content, oversized operations, and unsafe asset types are rejected before persistence/broadcast. |
| COL-008 | Restoring revision A while current head is C creates new revision D linked to A and C; revisions B/C remain readable to authorized history viewers. |
| COL-009 | A pinned public share continues showing its exact revision after private edits; a current-view share updates only as configured. Neither exposes comments, presence, history, or unrelated assets. |
| COL-010 | Revoking a public link invalidates origin and cached access within the documented edge window and cannot be bypassed with an asset URL copied from the page. |
| COL-011 | Canonical JSON export/import round-trips every supported block/element, ordering, binding, asset reference, comment policy, revision attribution, and content hash semantics. |
| COL-012 | An AI patch against stale revision N cannot apply silently to N+1; the user receives a semantic conflict/rebase preview. |
| COL-013 | Rejecting an AI proposal creates no canonical operation. Accepting it records model metadata, selected source revision, approving human, and resulting operation IDs. |
| COL-014 | Operation compaction followed by process restart and backup restore reproduces the exact head hash and named revisions. |
| COL-015 | CLI and MCP revision reads, compares, exports, and patch validation return equivalent versions and permission failures. |
| COL-016 | With AI disabled, create/edit, offline sync, comments, revisions, sharing, import/export, and collaboration remain functional. |
| COL-017 | Keyboard-only and screen-reader users can create/edit structured documents and perform essential canvas selection, labeling, movement, deletion, sharing, and export through accessible alternatives. |

## Explicitly deferred

- Pixel-compatible cloning or native-file compatibility with any referenced editor.
- General browser-based code execution, macros, or arbitrary embedded HTML.
- Video editing, full desktop-publishing layout, CAD, or design-system replacement.
- Anonymous edit links in the first release; public links are view/comment only until abuse and attribution controls are proven.
- Cross-workspace global asset deduplication.
