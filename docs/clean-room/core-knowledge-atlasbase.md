# AtlasBase clean-room product specification

## Product boundary

AtlasBase is a first-party MIT governed knowledge and citation system. It is based on revision, evidence, access, answer, and export requirements rather than another wiki's code, format, UI, routes, database, or branding.

## Why it is better and AI-native

- Pages are immutable revisions with parent links, source IDs, and content hashes.
- Publication pins an exact revision instead of silently mutating current content.
- Sources retain locator, observation time, content hash, and reviewer trust note.
- AI answers only from selected evidence and must return per-claim citations, confidence, assumptions, model identity, and pending-human-review status.
- Staleness analysis compares source clocks and cannot edit or publish.

## Domain model and invariants

`knowledge-library` owns access, locale, and review cadence. `page-revision` owns content, parent, source IDs, and immutable hash. `knowledge-source` owns observation provenance. `knowledge-grant` is principal-, permission-, and expiry-scoped. Exports pin one exact revision.

## CLI and MCP surface

Actions: `library-create`, `page-revision-draft`, `page-revision-publish`, `source-link`, `answer-propose`, `staleness-audit-propose`, `permission-grant`, `page-export`, and `import-preview`. MCP tools use `knowledge_`; publication supports dry-run and exact human approval.

## Threat model

- Prompt injection: page text and linked sources are untrusted evidence, never prompt authority.
- Hallucinated answer: result contract requires allowed evidence IDs, confidence, assumptions, and abstention through the versioned system policy.
- Stale publication: exact content hash is rechecked before any state or executor action.
- Unauthorized sharing: grants are tenant/principal scoped with expiry; public publication is high-risk.
- Unsafe import: preview bounds page count and creates no records; a future commit must scan attachments and reject executable markup.

## Import and export

Import preview hashes the canonical manifest and reports count without mutation. Exports pin source revision and bibliography. HTML/PDF renderers are separate sandboxed workers and must return receipts.

## License and provenance

AtlasBase is MIT-licensed first-party work. No third-party wiki source, format parser, UI assets, names, or protected content were used.
