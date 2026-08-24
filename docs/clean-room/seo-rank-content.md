# SEO rank and content module

## Product definition

| Field | Value |
| --- | --- |
| Module ID | `seo` |
| Working category | Search visibility and content operations |
| Minimum hosted plan | Starter, $7/month |
| Scale guidance | Scale for many sites, keywords, locales, scheduled crawls, or long history |
| License target | Original first-party source under MIT |
| Primary outcome | A business can measure search visibility from authorized data sources and convert observed changes into cited, reviewable content work. |

This module does not promise rankings and must not bypass search-engine controls. Ranking observations come from a customer-selected lawful provider, customer-owned proxy configuration, or authorized first-party search-console data.

## Public behavioral research record

- [SerpBear public repository and README](https://github.com/towfiqi/serpbear) describes domains, tracked keywords, historical positions, notifications, an API, optional Google Search Console data, and customer-selected SERP providers or proxies.
- [SerpBear MIT license](https://github.com/towfiqi/serpbear/blob/main/LICENSE) is the official upstream license record.
- [Google Search Console API documentation](https://developers.google.com/webmaster-tools) describes authorized access to a verified property's search-performance data.
- [Google Search Essentials](https://developers.google.com/search/docs/essentials) is a public source for Google-authored search guidance; the module must distinguish such guidance from model suggestions.

No SerpBear source, schema, provider adapter, interface, copy, tests, examples, or assets may be copied. Public provider APIs are integrated from their own current documentation and terms.

## Clean-room boundary

### Permitted inputs

- The external behaviors and source facts summarized here.
- Customer-authorized Search Console and analytics data.
- Public web pages the customer owns or is authorized to audit.
- Official provider API documentation and customer-supplied credentials.
- Public search-engine guidance with a stored source URL and retrieval date.

### Prohibited inputs

- Upstream code, database layout, endpoint names, UI, alerts, provider implementation, or test cases.
- CAPTCHA solving, authentication circumvention, stealth browser fingerprinting, or unbounded direct querying of a search engine.
- Invented ranking, traffic, search volume, competitor, backlink, or conversion data.
- Generated content published without a human-approved workflow.

## Actors and permissions

| Actor | Capabilities |
| --- | --- |
| Workspace owner | Manage sites, connectors, credentials, retention, exports, and members. |
| SEO manager | Configure keywords, locations, schedules, alerts, audits, and approved recommendations. |
| Content editor | Read evidence, draft briefs and content changes, and mark work completed. |
| Analyst | Read observations, trends, and reports without provider secrets. |
| Viewer/client | Read selected reports and public share links. |
| Scheduler | Lease bounded rank, import, crawl, and analysis jobs. |

Connector credentials, public report publication, and destructive history operations require privileged scopes.

## Original data requirements

The implementation owns a PostgreSQL schema named `seo`.

### `site`

- Name, canonical origin, verified domains, locale/time zone, target countries, default device, ownership verification, and crawl limits.
- A site may be monitored without ownership for public ranking observations, but Search Console connection and content mutation require ownership authorization.

### `connector`

- Type, encrypted credential reference, capabilities, quota policy, health state, last success/failure, and configuration version.
- Types may include Search Console, analytics, SERP provider, customer proxy, sitemap, or CMS publishing adapter.
- Secrets live in the core secret store and are never returned after creation.

### `keyword`

- Exact query, normalized key, site, locale, country, location granularity, device, tags, intent review state, active state, and tracking schedule.
- The exact query is immutable for a time series; editing creates or links a new series.

### `rank_check`

- Keyword, provider, requested context, leased time, completion time, state, cost/usage units, and diagnostic error class.
- States: `queued`, `running`, `completed`, `partial`, `failed`, `canceled`, `quota_blocked`.
- Idempotency prevents duplicate billable requests for the same keyword/context/window.

### `rank_observation`

- Check, observed time, organic position or `not_found`, result URL, result type, page/title evidence where permitted, and provider response hash.
- Observation data is immutable. Reprocessing can append normalized interpretations without replacing raw evidence.

### `search_metric`

- Authorized property, query/page/date dimensions, clicks, impressions, CTR, average position, source connector, and import time.
- The module preserves source semantics and never merges provider rank with Search Console average position as if they were the same measurement.

### `page_snapshot`

- Site URL, canonical URL, response metadata, indexability directives, structured headings, links, content hash, measured text summary, and capture time.
- Raw page bodies are optional and retention-bounded; credentials, form values, and private areas are excluded.

### `content_issue`

- Page/site, issue type, severity, deterministic evidence, first/last observation, state, assignee, and resolution evidence.
- States: `open`, `accepted`, `in_progress`, `resolved`, `ignored`, `regressed`.

### `recommendation`

- Evidence references, suggested action, rationale, confidence, model metadata when applicable, reviewer, and outcome.
- Recommendations never masquerade as measured facts.

### `content_brief`

- Target audience/query set, evidence, outline, factual sources, internal-link candidates, status, author, and approved publication destination.
- States: `draft`, `review`, `approved`, `published`, `withdrawn`.

### `alert_rule` and `alert_event`

- Rule predicates over measured changes, evaluation windows, cool-down, recipients, and immutable trigger evidence.
- Alert evaluation is deterministic even if AI supplies a narrative summary.

## Required workflows

### 1. Add a site and data sources

1. A manager creates a site and sets target locale/device contexts.
2. Optional ownership verification unlocks Search Console and publishing connectors.
3. Connector setup stores the secret once, probes only the requested capability, and reports quota and health separately.
4. Provider terms and usage costs are shown before scheduling requests.

### 2. Discover and manage keywords

1. Users add exact keywords manually or import from authorized Search Console data and files.
2. AI may propose deduplication, intent clusters, and tags while preserving each exact query.
3. A human selects which queries become billable scheduled checks.
4. Schedule preflight estimates provider calls and rejects work exceeding configured quota.

### 3. Run a rank check

1. Scheduler leases a unique keyword/context/window job.
2. The connector performs one bounded provider request with timeout and retry policy.
3. The response is normalized into immutable observations with provenance.
4. Provider quota, authentication, network, parse, and `not_found` outcomes remain distinct.
5. Trends and alerts are computed only after durable persistence.

### 4. Import first-party performance

1. The user authorizes an exact Search Console property and date range.
2. Incremental imports preserve the source dimensions and API clock.
3. Replays upsert by the documented source key without double-counting.
4. The UI distinguishes provider snapshots, Search Console aggregates, and modeled recommendations.

### 5. Audit content

1. A bounded crawler reads robots directives and customer scope.
2. It records page snapshots and deterministic issues such as unreachable pages, conflicting canonicals, broken internal links, or missing customer-required metadata.
3. AI may explain or group issues but cannot create evidence.
4. A later scan marks resolved and regressed issues without deleting history.

### 6. Produce and execute recommendations

1. A manager selects measured observations, search metrics, page snapshots, and business context.
2. AI drafts a brief with citations to those records and clearly marked external guidance.
3. An editor reviews facts, claims, target terms, and proposed internal links.
4. Publishing requires a separately configured CMS adapter and approval; otherwise export is the terminal action.
5. Post-publication measurements link the change to later observations without claiming causation.

### 7. Report and notify

1. Deterministic alert rules evaluate completed measurements.
2. AI optionally summarizes what changed, citing exact dates, queries, pages, and sources.
3. Reports expose data freshness, missing checks, provider errors, and estimated external cost.
4. Public/client links include only an explicitly selected report snapshot.

## AI contract

### Allowed AI actions

- Cluster keywords and suggest search intent with confidence.
- Explain measured changes and content issues with record citations.
- Draft content briefs, titles, outlines, and internal-link suggestions.
- Compare page snapshots and summarize what changed.
- Suggest an investigation order based on business context and measured impact.

### Forbidden AI actions

- Generate or alter rank observations, impressions, clicks, volumes, or provider status.
- State that a content change caused a ranking outcome without valid experimental evidence.
- Publish to a CMS, delete keywords, or enable billable schedules without approval.
- Copy competitor content or produce misleading search-engine manipulation.
- Send connector tokens, private page contents, or unredacted query parameters to a remote model.

Every narrative contains a machine-readable `evidence_ids` list. A claim without supporting workspace data is labeled `suggestion` or `external_guidance`.

## HTTP, CLI, and MCP surface

Representative CLI commands:

```sh
supersuite seo site create --origin https://example.com --locale en-US
supersuite seo connector add --site SITE_ID --type search-console
supersuite seo keyword import --site SITE_ID --file keywords.csv --dry-run
supersuite seo rank run --keyword KEYWORD_ID --idempotency-key KEY
supersuite seo audit start --site SITE_ID --max-pages 250
supersuite seo brief draft --site SITE_ID --keyword KEYWORD_ID --page PAGE_ID
supersuite seo report export --site SITE_ID --from 2026-08-01 --to 2026-08-31
```

Required MCP tools:

- `seo_site_list`
- `seo_keyword_list`
- `seo_keyword_import`
- `seo_rank_run`
- `seo_rank_history`
- `seo_metric_query`
- `seo_audit_start`
- `seo_issue_list`
- `seo_brief_draft`
- `seo_brief_approve`
- `seo_report_create`

`seo_rank_run` reports estimated provider units before mutation. `seo_brief_approve` cannot publish; publishing is a separate connector-scoped operation with an exact content version.

## Resource and plan contract

- Starter supports normal low-volume tracking and content audits inside pooled workspace quotas.
- Scale is recommended for multiple sites, local/device matrices, frequent checks, long history, or broad crawls.
- SERP provider, proxy, Search Console, model, and CMS costs are external usage and itemized separately.
- Scheduler enforces per-workspace concurrency, daily provider-unit ceilings, crawl rate, and disk retention.
- When quotas are exhausted, jobs enter `quota_blocked`; they do not spin, retry endlessly, or fabricate stale success.

## Security and operational requirements

- OAuth tokens and provider keys use encrypted core secret references and minimum scopes.
- Crawls reject private-network targets, metadata endpoints, loopback, unsafe redirects, and out-of-scope hosts.
- User agents identify the service; crawls honor configured policy and stop controls.
- Provider rate-limit or security-challenge responses are terminal for that attempt and trigger backoff.
- Public reports are immutable snapshots with revocable opaque tokens.
- Customer exports include measurement provenance and clocks.

## Behavioral acceptance tests

| ID | Black-box behavior |
| --- | --- |
| SEO-001 | Two workspaces track the same site and keyword; neither can observe the other's connectors, checks, history, briefs, costs, or exports through any interface. |
| SEO-002 | Replaying a rank request with the same keyword/context/window and idempotency key produces one provider call and one durable check. |
| SEO-003 | `not_found`, quota exhaustion, invalid credential, timeout, and parse failure produce distinct states and never become position zero. |
| SEO-004 | A completed observation remains byte-equivalent after trend recomputation, AI analysis, process restart, and backup restore. |
| SEO-005 | Search Console average position and a SERP provider's point-in-time position remain separately labeled and queryable. |
| SEO-006 | Importing an overlapping Search Console date range twice does not double-count clicks or impressions. |
| SEO-007 | A crawl attempting to redirect to a cloud metadata address is rejected before a request reaches the target and produces a security audit event. |
| SEO-008 | A newly broken internal link creates an evidence-backed issue; a later fixed scan resolves it, and a subsequent break marks it regressed without deleting history. |
| SEO-009 | An AI summary that mentions a ranking change includes exact observation identifiers and dates; unsupported traffic or causation claims fail output validation. |
| SEO-010 | A generated brief remains a draft until an authorized reviewer approves its exact version; approval never sends it to a CMS. |
| SEO-011 | A billable schedule that exceeds the configured provider-unit ceiling fails preflight and makes no external calls. |
| SEO-012 | A provider HTTP 429 or security challenge schedules bounded backoff and does not start a parallel retry loop. |
| SEO-013 | Public report access reveals only the selected immutable snapshot and can be revoked without deleting the private report. |
| SEO-014 | CLI and MCP perform equivalent rank-history reads and return provenance, freshness, and missing-data fields. |
| SEO-015 | With AI disabled, users can add sites/keywords, run checks, view history, audit pages, configure alerts, and export reports. |

## Implemented first slice

The shared suite currently registers this as a Starter/shared-resource module and exposes generated CLI/MCP actions for public-origin configuration, immutable exact-query series, rank-job preflight, safe audit queues, evidence-linked brief creation/approval, and cited AI drafting. The server engine enforces:

- DNS resolution to public addresses before site activation and before every queued audit;
- same-origin audit targets, bounded page counts, no credentials, no persisted query strings, and an explicit same-origin/public-only redirect policy for the future crawler worker;
- case/spacing-normalized duplicate detection while retaining the original exact query;
- customer-provider-only rank jobs, 16-character idempotency keys, one durable replay result, provider-unit estimates, and daily ceilings before any external call begins;
- workspace/site/keyword ownership for every cited record, deterministic brief hashes, exact-version approval, and `cmsPublished: false`; and
- allowlisted AI context that excludes arbitrary connector data or secrets.

The rank action only creates a durable `queued` job with `externalCallStarted: false`; provider execution and immutable outcome ingestion belong in the provider worker with encrypted connector credentials. The route owner must also add a revocable, opaque-token public report endpoint after report snapshot commands exist. Neither external provider execution nor a public report surface is currently claimed by this slice.

## Explicitly deferred

- Backlink indexes, global keyword-volume databases, or web-scale crawling.
- CAPTCHA solving or direct scraping designed to evade platform controls.
- Automated bulk content publishing.
- Guaranteed rank improvement or generated claims of causal lift.
- Authenticated competitor-site crawling without documented authorization.
