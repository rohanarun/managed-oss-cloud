# Northstar Work clean-room product specification

## Product boundary

Northstar Work is a first-party MIT project and work ledger built from planning, dependency, capacity, and delivery jobs. It does not copy another task manager's source, UI, API, schema, fixtures, or brand.

## Why it is better and AI-native

- Each project declares its states, finish state, and per-state work limits.
- Dependencies are graph-validated and cannot cycle.
- Work transitions move one configured edge at a time and enforce predecessor completion and capacity.
- Sprint scope is content-addressed so later scope changes remain observable.
- AI workload and risk proposals cite selected items, expose confidence/prompt/model/review data, and never reassign, complete, or move work.

## Domain model and invariants

`project` owns states, initial/terminal state, and work-in-progress limits. `work-item` owns acceptance criteria, priority, due time, state, and version. `work-item-dependency` is an acyclic edge. `sprint` freezes item IDs and a scope hash. `time-entry` records a positive whole-minute interval no longer than 24 hours.

## CLI and MCP surface

Actions: `project-blueprint-create`, `work-item-create`, `dependency-link`, `work-item-transition`, `sprint-commit`, `workload-rebalance-propose`, `delivery-risk-explain`, `time-log`, and `project-export`. MCP names use `tasks_`; schemas and CLI examples are generated from the same definitions.

## Threat model

- Race/lost update: work transitions use expected version.
- Graph denial of service: action schemas bound arrays; integration should also bound whole-project graph size.
- Silent scope inflation: committed sprint IDs and scope hash remain immutable.
- Autonomous workforce decisions: model outputs are proposals requiring human review and cannot mutate assignees or state.
- Cross-tenant IDs: every project/item/edge is dereferenced through the authorized workspace; persistence must also enforce RLS.

## Import and export

Project export is a private canonical manifest covering states, items, dependencies, scope, and history. Future imports must preview unknown states, broken edges, and identity conflicts before a commit.

## License and provenance

Northstar Work code/specification is MIT. No third-party task-manager source, content, visual assets, or names are included.
