# RouteKit clean-room product specification

## Product boundary

RouteKit is a first-party MIT branded-route, redirect, experiment, and privacy-safe analytics engine. It comes from link-management jobs and security requirements, not copied short-link code, API behavior, screens, schemas, or branding.

## Why it is better and AI-native

- Routes and destination versions are separate; publication points to an exact reviewed content hash and preserves rollback history.
- HTTPS credential-free destination validation is deterministic and runs before publication.
- Visitor experiments use stable content-addressed weighted allocation, not a model.
- Events reject raw IP, email, address, name, and fingerprint dimensions.
- AI destination risk review is a cited proposal with timestamps, confidence, prompt/model provenance, and no ability to publish, block, visit, or disable.

## Domain model and invariants

`link-route` owns hostname, slug, privacy mode, active version, and route version. `destination-version` owns exact HTTPS destination, campaign metadata, and content hash. `link-event` owns coarse observed dimensions. Route disable retains destination and event history.

## CLI and MCP surface

Actions: `route-create`, `destination-version-create`, `destination-publish`, `redirect-resolve`, `event-ingest`, `experiment-allocate`, `destination-risk-propose`, `route-disable`, and `analytics-export`. MCP tools use `links_`; publish and disable include dry-run and approval contracts.

## Threat model

- SSRF/open redirect: only public credential-free HTTPS destinations are allowed; production executor must additionally resolve DNS and reject private/reserved addresses on every publish and redirect.
- Domain hijack: hostname ownership stays in the hosting layer and must be proven before a route becomes public.
- Tracking abuse: raw identity/fingerprint dimensions are rejected; aggregate/no-analytics modes are durable.
- Experiment instability: canonical variant order and weights produce a stable allocation hash.
- AI safety overclaim: the model may propose risks but cannot claim a URL is safe or mutate the route.

## Import, export, and public redirect

Analytics export is aggregate-only with explicit from/to clocks. Public resolution should read the active version through a tenant/domain registry and append only policy-permitted events. Provider or reputation imports must preserve source and observation time.

## License and provenance

RouteKit is MIT-licensed first-party work. No third-party link product code, UI, logo, API, analytics logic, or trade dress was reused.
