# IdeaLoop clean-room product specification

## Product boundary

IdeaLoop is a first-party MIT feedback, voting, roadmap, and changelog system. It was designed from user feedback workflows and audit requirements, not copied source, interfaces, screens, schemas, or branding.

## Why it is better and AI-native

- Every original request and vote survives reviewed merges.
- One pseudonymous voter hash has one reconciled vote per request, preventing retry inflation.
- Status changes require an expected version and a public explanation.
- Impact scoring is deterministic, inspectable, and user-weighted rather than opaque AI ranking.
- AI suggests duplicate clusters with exact citations and confidence but never merges or hides requests.

## Domain model and invariants

`feedback-board` owns visibility and voting policy. `feedback-request` owns consent, problem, status, and version. `feedback-vote` owns voter hash and active/withdrawn decision. `merge-event` preserves source and target IDs. `changelog-entry` proves reviewed content before external publication.

## CLI and MCP surface

Actions: `board-create`, `request-submit`, `vote-cast`, `duplicate-cluster-propose`, `request-merge`, `status-transition`, `changelog-publish`, `impact-score`, and `feedback-export`. MCP tools use `feedback_`; merge and changelog actions expose dry-run and structured approval.

## Threat model

- Vote manipulation: voter hashes reconcile rather than append duplicate votes; public hosting must rate-limit and authenticate its voter-key derivation.
- AI popularity bias: clustering retains low-volume originals and cannot affect counts or visibility.
- Destructive merge: only owner/admin approval can redirect; original records and votes remain available.
- Unreviewed claims: changelog publication requires shipped requests, exact approval, and an executor receipt.
- Privacy: exports honor submission consent and should exclude raw public identity keys.

## Import and export

Feedback export contains requests, reconciled votes, merges, statuses, and changelog relationships. Public submissions enter through a hosting-layer abuse/consent check before `request-submit`.

## License and provenance

IdeaLoop is new MIT code and documentation. No third-party feedback product source, UI, assets, API, or trade dress was reused.
