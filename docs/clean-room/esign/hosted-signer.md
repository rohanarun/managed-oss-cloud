# Hosted signer security boundary

This document defines the public signer surface for the clean-room e-signature workflow. The surface records basic workflow facts. It does not certify legal compliance, establish signer identity, create a qualified signature, provide legal advice, or let a model complete or decline an agreement.

## Mount contract

Create one `HostedEsignService`, then mount `createHostedEsignRouter` at `/api/public/esign`:

```ts
const hostedEsignService = new HostedEsignService({
  store: suiteStore,
  objectLoader: exactSanitizedPdfLoader,
  rateLimiter: sharedProductionRateLimiter,
  maximumPdfBytes: 50 * 1024 * 1024,
  now: () => new Date(),
});

app.use(
  "/api/public/esign",
  createHostedEsignRouter({
    service: hostedEsignService,
    allowedOrigins: [config.PUBLIC_SIGNER_ORIGIN],
    requireTls: true,
    trustForwardedProto: true,
    clientKey: (request) => trustedProxyDerivedClientKey(request),
  }),
);
```

`trustForwardedProto` is safe only when the app accepts traffic exclusively from its trusted TLS terminator and the proxy replaces, rather than appends to, the forwarded-protocol header. Otherwise leave it false and terminate TLS in-process.

The optional `clientKey` resolver is necessary when every request reaches Node from one reverse-proxy address. It must derive a stable client key only from a header replaced by the trusted proxy. Never trust a client-appended forwarding header. The router hashes the resolved key before the service and the service hashes it again before handing it to the limiter.

The router exposes only four POST endpoints:

| Endpoint | Purpose | Result |
| --- | --- | --- |
| `/session` | Resolve the exact active signer session | Disclosure, immutable hashes, assigned fields, and explicit choices |
| `/document` | Load and re-verify the exact registered PDF | No-store inline PDF bytes |
| `/complete` | Record one explicit complete decision | Minimal receipt metadata |
| `/decline` | Record one explicit decline decision | Minimal receipt metadata |

The exact machine-readable shape is also available from `hostedEsignMountContract()`.

## Credential transport

An opaque signer token is accepted in exactly one of these locations:

- `Authorization: Bearer <opaque signer token>`
- the JSON request-body field `sessionToken`

Tokens in the path, query string, cookie, referrer, response, or log are forbidden. A request with both supported credential locations is rejected. The module computes SHA-256 immediately after receiving the credential and uses constant-time hash comparison against the stored session hash. Plaintext is held only long enough to invoke the existing e-sign engine, whose idempotency digest replaces the token with its SHA-256 and whose persisted session contains only the hash.

Do not enable request-body or authorization-header logging on this mount. Proxy access logs must omit request bodies, authorization headers, and query strings. Error responses are intentionally generic and never contain the supplied credential.

Every browser request must include:

- `Content-Type: application/json`
- `X-Hosted-Signer-Request: 1`
- an exact configured `Origin`
- HTTPS transport

The mount rejects ambient cookies and every query parameter. Origins are exact URL origins, not wildcard suffixes. The router sets no-store, HSTS, no-referrer, no-frame, no-sniff, restrictive CSP, restrictive permissions, and exact-origin CORS headers.

## Tenant and immutable-boundary verification

The public request carries the opaque workspace ID because the existing `SuiteStore` intentionally has no cross-tenant token lookup. That ID is not authentication. The token hash must resolve to exactly one signer session inside that workspace. A token presented with another workspace ID fails as an invalid session.

Before displaying a signer view, the service verifies all of the following:

- the workspace is paid, active, and has the e-sign module enabled;
- the session is active, unexpired, and bound to the envelope signer route;
- the envelope is active and unexpired;
- the signer ID, signer-key hash, role, and route order match exactly;
- the immutable template-version content hash recomputes from its roles, fields, disclosure, and instructions;
- the envelope field and disclosure snapshots match that template version;
- the document registration hash recomputes from the object reference, object version, SHA-256, byte count, media type, and page count;
- the envelope document hash and object version match the immutable document record;
- the envelope draft hash recomputes from the entire template, document, signer, field, disclosure, expiry, and message boundary.

The session response adds a `disclosureHash` and a comprehensive `boundaryHash`. Complete and decline requests must echo both hashes plus the exact session and envelope versions. A stale or altered view fails before mutation.

## Exact PDF loader

`HostedEsignObjectLoader.loadExactPdf` is an explicit infrastructure dependency. Its implementation must:

1. authorize access using the supplied workspace and owner IDs;
2. resolve the opaque object reference without accepting a URL or filesystem path from the public request;
3. request the exact immutable object generation/version;
4. run a production PDF parser and active-content sanitizer before registration or serving;
5. return only an object carrying `safetyProfile: "sanitized-static-pdf.v1"`;
6. never substitute a newer object generation.

The hosted service independently checks the returned media type, object version, safety profile, byte count, source SHA-256, recomputed byte SHA-256, and PDF file signature. Any discrepancy returns `document_unavailable` and no bytes.

The safety profile is a contract, not a claim that a five-byte magic check sanitizes a PDF. The loader must be backed by a maintained PDF parser/sanitizer and must register the sanitized bytes as the content-addressed object. Reject encrypted, malformed, active-content, embedded-file, external-action, and parser-ambiguous inputs before they reach this service.

## Explicit decisions

The UI must render the disclosure, the exact PDF, and two separate controls: complete and decline. It must not preselect a decision or invoke either endpoint from a model, agent, timer, page load, or inferred gesture.

Complete requires:

- `decision: "complete"`;
- `reviewedDisclosure: true`;
- exact disclosure and boundary hashes;
- exact session and envelope versions;
- a unique decision ID;
- an ISO `decidedAt` clock captured when the signer made the decision and reused unchanged on retry;
- one hash-only completion fact for every required field.

The public surface never accepts or stores raw signature drawings, typed names, field text, or checkbox values. A trusted client hashes the field value before submission. The existing engine rechecks field ownership, required fields, method compatibility, clocks, versions, session token, and workflow state inside the workspace transaction. The service re-verifies the PDF immediately before calling that engine.

Decline requires the same explicit reviewed boundary, versions, and decision ID plus a bounded reason. It records `signatureOccurred: false`. Decline remains available without loading the PDF again so a signer can refuse even if object delivery becomes unavailable.

Both paths use the existing `executeEsignAction` command boundary. The internal owner-scoped authorization exists only to satisfy the engine's platform approval invariant. The persisted approval reason records that the hosted signer explicitly chose the operation against the exact disclosure and boundary hashes. `decidedAt` is validated against the signer-session window and becomes the stable approval clock, so an exact retry does not change the engine request hash. Once a session is terminal, the hosted service admits only a same-operation replay candidate; the engine's durable request hash must still match before it can return the original receipt. Complete retries do not require the PDF object to remain temporarily available because they cannot enter the mutation path after the session is terminal. Responses expose only decision, envelope/session IDs, terminal state, receipt ID, and the durable receipt clock. They do not expose records, token hashes, signer-key hashes, or internal approvals.

The service refuses to buffer a hosted PDF larger than 50 MiB. A deployment may configure a smaller `maximumPdfBytes`, but never a larger one. The registered size is checked before the loader is called, and the returned byte length is checked before `Buffer.from` or hashing. This is a memory-safety boundary for the current buffered API, not a substitute for sanitizer, object-version, or content-hash verification.

Signer sessions are resolved through the tenant-bound `findSignerSessionByTokenHash` store method. PostgreSQL uses the unique partial `esign_signer_session_token_hash_idx`; the hosted surface never scans a workspace's session history. Memory-mode tests preserve the same exact-one-match integrity rule.

## Rate limiting and production deployment

`InMemoryHostedEsignRateLimiter` is a safe single-process default. It applies both client-derived and credential-derived hash buckets. Multi-instance production must inject a shared atomic limiter, such as a Redis-backed implementation, with the same `HostedEsignRateLimiter` interface. Never use a raw token, authorization header, or IP address as the stored rate-limit key.

Production deployment must additionally provide:

- a trusted TLS terminator and an exact signer origin;
- a shared rate limiter across replicas;
- object storage generation pinning and sanitizer evidence;
- body/header redaction in proxy, APM, trace, and error systems;
- alerts for repeated boundary mismatches and object-verification failures without recording credentials;
- retention and deletion policies for document objects and immutable workflow facts;
- a jurisdiction-specific legal review before making any claims beyond the basic workflow facts implemented here.

The router is deliberately not mounted automatically. The main control-plane integration must supply the production object loader, shared limiter, proxy trust policy, and exact origin explicitly.
