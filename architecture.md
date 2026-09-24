# Architecture: Signal Room AI Technical Interview Coach

**Status:** Source of truth

**Last updated:** 2026-09-24

**Owner:** Project engineering

**Target:** P0 local prototype plus v2 Phase 1 invite-only pilot (lean AWS)
**Deployment state:** Implemented and locally verified; cloud resources are not yet deployed

## 1. Authority and change policy

This document defines the accepted product scope, runtime boundaries, provider integration, persisted contracts, privacy rules, security controls, tests, cost limits, and delivery model. When code and this document disagree, this document wins until both are updated together.

An architecture-changing pull request must update this file and the decision log, update affected schemas and tests, state migration effects, and preserve deterministic mock mode for local development and CI.

## 2. Product boundary

Signal Room is a candidate-facing technical interview coach. It does not make employer screening or hire/no-hire decisions.

### P0 local mode

Without credentials or cloud services, candidates can choose system-design, ML-design, or algorithms at mid/senior/staff difficulty, complete a scripted text interview, edit code in Monaco, build a structured design canvas, inject a requirement, and receive an evidence-linked deterministic scorecard. State is held in browser memory and disappears on reload.

### Phase 1 invite-only pilot

- Cognito authorization code + PKCE sign-in; self sign-up disabled. The owner invites accounts into `owner` or `guest` using `scripts/invite-user.*`.
- Accounts in neither group cannot create sessions: `403 account_not_enabled` before table access.
- Constrained, short-lived Gemini Live credentials, with audio sent directly from the browser to Gemini.
- Separate UTC-month allowances: voice global hard cap **10**, owner 10, guest 2; text global hard cap **60**, owner 60, guest 5. Text counter keys and limits are defined now; text interviews ship in Phase 2.
- Maximum **10 minutes per voice interview**; global and per-role limits can be lowered but not raised above the hard caps.
- Append-only transcript, code, canvas, scenario, usage, and lifecycle evidence.
- Asynchronous independent grading with evidence references in DynamoDB.
- Read-only account APIs for role/allowances, session history, and stored grading reports. The browser still renders the immediate deterministic scorecard; report/history UI ships in Phase 2.
- Production-only alarms, dashboard, custom metrics, SNS email notifications, and a monthly AWS budget.

`infra/lib/access-policy.ts` defines shared limits for synthesis and Lambda runtime validation; atomic DynamoDB conditions enforce voice reservations. Raising a hard cap is an architecture change. The future text endpoint must reserve its counters atomically before use.

Webcam, emotion/accent scoring, covert proctoring, payments, server-side arbitrary code execution, and mobile delivery remain excluded. Phase 2 introduces Coding/Behavioral tracks, a real question-aware interview loop, text interviews, report/history UI, and session deletion.

## 3. Architectural principles

1. **Gemini ecosystem first.** One Gemini Live session conducts the interview; a separate Gemini text call grades frozen evidence.
2. **Audio bypasses AWS.** The browser connects directly to Gemini Live after receiving a constrained credential.
3. **Secrets stay server-side.** The standard Gemini key is never sent to client code or browser storage.
4. **The web server is a BFF.** Cognito access tokens remain in a scoped HttpOnly cookie and are attached to AWS API calls only by Next.js route handlers.
5. **Evidence is append-only.** Events have stable IDs, sequence numbers, strict schemas, and retry-safe writes.
6. **Independent grading is idempotent.** Completion retries may re-enqueue work to repair delivery failures; the grader checks completion and takes a DynamoDB lease before a paid model call.
7. **No evidence in operational logs.** Transcripts, code, canvas content, audio, resumes, cookies, authorization headers, and credentials are rejected by the logging schema.
8. **Known access patterns first.** DynamoDB serves online state; relational infrastructure waits for demonstrated requirements.
9. **Cost is a product invariant.** Quotas bound usage, while measured provider billing decides later scaling.

## 4. Runtime topology

~~~mermaid
flowchart LR
  Browser[Browser: XState, Monaco, canvas, AudioWorklet] --> BFF[Next.js 16 BFF on Vercel]
  BFF <-->|code + PKCE| Cognito[Cognito: owner/guest groups]
  BFF -->|access token from HttpOnly cookie| API[HTTP API + Cognito JWT authorizer]
  API --> Session[Session Lambda]
  API --> Events[Event Lambda]
  API --> Account[Account Lambda]
  Session --> DB[(DynamoDB single table)]
  Events --> DB
  Account --> DB
  Session --> Parameter[SSM SecureString]
  Session --> Token[Gemini ephemeral-token service]
  Token --> Browser
  Browser <-->|direct audio WebSocket| Live[Gemini Live]
  Events --> Queue[SQS + DLQ]
  Queue --> Grader[Grader Lambda]
  Grader --> Parameter
  Grader --> Grade[Gemini text grader]
  Grader --> DB
  API --> Logs[Safe logs and X-Ray]
  Monitor[Prod: 8 alarms, dashboard, SNS email, $1 budget]
~~~

`/api/me`, `/api/sessions`, and `/api/sessions/[id]/report` proxy authenticated GETs to the Account Lambda. Session creation and evidence append use authenticated POST routes. Audio never traverses API Gateway or Lambda.

When `P1_API_URL` is unset in development/test, the BFF retains the local P0 path. Without `GEMINI_API_KEY`, that path returns a mock descriptor and contacts no provider. Production without `P1_API_URL` fails closed with 503.

## 5. Component decisions and implementation status

| Area | Decision | Status |
|---|---|---|
| Web | Next.js 16 App Router, React 19, TypeScript, project-owned CSS | Implemented |
| Lifecycle/workbench | XState, Monaco, lightweight structured canvas | Implemented |
| Provider boundary | Deterministic mock and Gemini adapters | Implemented |
| Hosting | Vercel frontend plus AWS Singapore backend | First deployment remains Task 16 |
| Application plane | CDK, HTTP API, four ARM Node.js 22 Lambdas: session/event/grader/account | Implemented, not deployed |
| Identity | Cognito Hosted UI, code + PKCE, invite-only owner/guest groups | Implemented, not deployed |
| Online data | DynamoDB on-demand single table; SQS + DLQ for grading | Implemented, not deployed |
| Secrets | SSM standard SecureString, AWS-managed `aws/ssm` key | Owner creates one parameter per stage |
| Object storage | No deployed recording bucket or upload path | Deferred until recording consent |
| Operations | Prod: 8 alarm metrics, 1 dashboard, 8 emitted custom metrics, SNS email, $1 budget | Implemented; live validation pending |
| Lambda releases | Direct function deployments; AWS before Vercel; backward-compatible `/v1` | Implemented |
| Reports/history | Account read API implemented; visible AI report and history pages | UI deferred to Phase 2 |
| Analytics and richer canvas | Offline analytics, React Flow, measured delivery metrics | Later phases |

No cloud deployment or billing result is implied by local tests. Phase 1 exit criteria require the owner's real deployment checkpoint.

## 6. Gemini Live strategy

- Live model: gemini-3.1-flash-live-preview.
- Grader model: gemini-2.5-flash-lite by default.
- Transport: browser-to-Gemini stateful WebSocket.
- Input: raw signed 16-bit little-endian PCM at 16 kHz.
- Output: raw signed 16-bit little-endian PCM at 24 kHz.
- Target microphone chunks: 20–40 ms.
- Live config: audio response, input/output transcription, session resumption, and context compression.

Credential boundaries:

- Local P0 Live mode: POST /api/realtime/session may read GEMINI_API_KEY.
- P1 session and grader Lambdas read `/signal-room/<stage>/gemini-api-key` from SSM SecureString using `GEMINI_KEY_PARAMETER_NAME`, with decryption and a five-minute per-container cache.
- P1 Next.js receives only a constrained Gemini credential from the authenticated AWS API.
- No Gemini secret may use a NEXT_PUBLIC_ prefix, enter a client bundle, appear in a fixture, or be logged.

P1 credentials are limited to the selected configuration, are single-use for session initiation, and expire after the requested duration plus two minutes (at most 12 minutes). The browser uses an unpausable wall clock and ends the product session at ten minutes. Because media goes directly to Gemini after credential issuance, AWS cannot revoke that connection at exactly ten minutes; the credential lifetime is therefore the provider-side upper bound. Local Gemini credentials use the same 12-minute ceiling.

Context compression starts at 25,000 tokens with an 8,000-token sliding window. Session resumption is enabled. Persisting resumption handles and a complete GoAway/network-loss recovery experience are deferred. Provider switching in the middle of speech is unsupported.

References: [Live API](https://ai.google.dev/gemini-api/docs/live-api), [ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens), [session management](https://ai.google.dev/gemini-api/docs/live-api/session-management), and [Live API practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices).

## 7. Authentication and web security

1. GET /api/auth/login creates a random state and PKCE verifier/challenge.
2. State/verifier values use short-lived HttpOnly, SameSite=Lax cookies scoped to the callback.
3. Cognito redirects an authorization code to /api/auth/callback.
4. The BFF verifies state with a timing-safe comparison and exchanges the code server-to-server.
5. Only the access token is retained in an HttpOnly, SameSite=Lax cookie scoped to /api; refresh and ID tokens are discarded.
6. Mutating BFF routes require an exact trusted Origin, JSON content type, bounded body, and strict schema.
7. P1_API_URL is a fixed HTTPS origin; user input cannot select an upstream.

The access tier comes only from the Cognito-signed `cognito:groups` claim. The parser accepts bracketed space-separated strings, JSON arrays, CSV, and arrays; owner takes precedence over guest and unrecognized claims resolve to none. The actual HTTP API claim format remains deployment verification item V4. `CONTACT_URL` is server-only configuration; `/api/auth/session` exposes only a validated HTTPS or mailto request-access link, and omits it when unset or invalid.

Pages use a per-request nonce CSP. Production omits unsafe-eval; unsafe-inline remains limited to styles because Monaco injects runtime styles. The app also emits HSTS in production, frame denial, MIME sniffing prevention, strict referrer policy, restrictive Permissions Policy, COOP, and CORP.

## 8. Provider-neutral API contracts

### POST /v1/realtime/sessions

The BFF exposes this at POST /api/realtime/session.

~~~ts
// request
{
  track: "system-design" | "ml-design" | "algorithms";
  difficulty: "mid" | "senior" | "staff";
  providerPreference: "gemini";
  durationMinutes: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
}

// response
{
  sessionId: string;
  mode: "gemini";
  provider: "gemini";
  model: string;
  token: string;
  expiresAt: string;
  maxDurationMinutes: number;
  persistence?: "aws";
  resume: {
    enabled: boolean;
    contextCompressionTriggerTokens: number;
    slidingWindowTokens: number;
  };
}
~~~

An Idempotency-Key of 8–128 URL-safe characters is required or derived from the API request ID. Session creation first reserves global/user quota and a provisioning manifest, then requests exactly one Gemini token, then atomically marks the session created and stores a short-lived encrypted response record. The same key and request may replay that exact response for two minutes without consuming another quota unit or creating a second token; concurrent in-progress replay returns 409, and token-provisioning failure attempts to compensate the reservation. Reuse for a different request returns 409.

### POST /v1/interview-events

The BFF exposes this at POST /api/interview-events.

- Maximum 25 events and 256 KiB encoded JSON per batch.
- UUID event/session IDs, sequence at least 1, and ISO timestamps.
- Events are contiguous relative to baseSequence inside each batch.
- An identical event ID/sequence/payload is an idempotent duplicate.
- Reusing an ID or sequence for changed content returns 409.
- A unique out-of-order batch may fill a gap; the high-water sequence never moves backward.
- A session accepts no more than 500 stored events and accepts writes only until 120 seconds after its planned end.
- interview.completed must be the final item in its batch, must name its own sequence as finalSequence, and permanently closes the session to new evidence.

Current event types are question.started, question.completed, transcript.final, code.patch, code.snapshot, canvas.patch, canvas.snapshot, scenario.injected, execution.result, connection.reconnected, tool.call, provider.usage, and interview.completed.

### Account API (read-only)

All three routes require the Cognito JWT authorizer. Their BFF equivalents forward the cookie's access token, accept only allowlisted paths on the fixed `P1_API_URL` host, re-validate responses, disable caching, and never echo upstream error bodies.

| AWS route | BFF route | Response |
|---|---|---|
| `GET /v1/me` | `GET /api/me` | Role (`owner`, `guest`, `none`) and voice/text quotas: `used`, `limit`, `globalRemaining`, UTC `resetsAt` |
| `GET /v1/sessions` | `GET /api/sessions` | `items` with sessionId, createdAt, channel, track, level, questionTitle, status and optional overallScore; optional nextCursor |
| `GET /v1/sessions/{sessionId}/report` | `GET /api/sessions/[id]/report` | Status (`pending`, `grading`, `complete`, `failed`), optional v1 report and gradedAt |

The exact strict Zod contracts are in `src/lib/p1/account.ts` and `report.ts`. Report schema version 1 includes summary and competency scores with confidence, evidence references, feedback, and retry prompts. The overall score is the competency mean rounded to one decimal.

History is newest first. `limit` defaults to 20 and is bounded to 1–50. Cursors are base64url `{PK, SK}` values: extra keys, foreign `USER#<sub>` partitions, non-history prefixes, and malformed input are rejected before querying. Report reads validate the ID and session ownership before reading the report; missing and other-user sessions both return the identical 404. Corrupt stored reports fail closed with a safe internal error.

Ungrouped signed-in callers may read `/v1/me` with zero personal allowance; session creation returns `403 account_not_enabled`. Exhausted voice allowance returns `429 monthly_quota_exhausted`. Public demo behavior and account-read behavior are distinct.

## 9. DynamoDB model and consistency

| Entity | PK | SK |
|---|---|---|
| Session manifest | SESSION#sessionId | META |
| Evidence event | SESSION#sessionId | EVENT#zero-padded-sequence |
| Event-ID reservation | SESSION#sessionId | EVENT_ID#eventId |
| Report / grading lease | SESSION#sessionId | REPORT#P1#v1 |
| Request idempotency | USER#cognito-sub | SESSION_REQUEST#key |
| Short-lived session response | USER#cognito-sub | SESSION_RESPONSE#key |
| Global quota | QUOTA#GLOBAL#VOICE or QUOTA#GLOBAL#TEXT | MONTH#YYYY-MM |
| User quota | QUOTA#USER#cognito-sub#VOICE or ...#TEXT | MONTH#YYYY-MM |
| Session history | USER#cognito-sub | SESSION#createdAtIso#sessionId |

Session creation atomically increments the global and user voice counters and writes idempotency, session, and history records. History starts active and META stores historySk; provisioning rollback removes the owned history item with the reservation. Accepted completion sets history to grading in the evidence transaction. The grader records graded/overallScore, or failed on the final SQS attempt. The report record is authoritative; history is a derived index and a failed history update must not repeat paid grading. The failure write cannot overwrite a complete report, and the SQS failure response still permits DLQ delivery. The queue and grader share GRADING_MAX_RECEIVE_COUNT=3. IAM grants the underlying item actions (PutItem/UpdateItem/DeleteItem/GetItem/Query), which DynamoDB checks inside transactions.

Session creation preserves its original idempotency and conditional-write protections. Event writes atomically advance the sequence high-water mark and reserve sequence and event ID. The Cognito subject must match the session owner.

A newly accepted completion event is queued for grading. An exact duplicate completion is also re-enqueued so a client retry repairs the DynamoDB-commit/SQS-send failure window. Before invoking Gemini, a worker conditionally creates a 90-second lease. Duplicate SQS delivery or concurrent workers therefore do not normally duplicate model spend; an expired lease permits recovery.

## 10. SQL versus NoSQL

| Dimension | PostgreSQL / SQL | DynamoDB / NoSQL |
|---|---|---|
| Strength | Joins, constraints, flexible transactional queries | Known low-latency access patterns and append-only aggregates |
| Operations | Migrations, indexes, connections, failover | On-demand capacity, no connection pool |
| Risk here | Complexity before relational needs exist | Bad key design or scans |
| Current fit | Offline analytics later | Sessions, quotas, evidence, reports |

P1 uses DynamoDB as the only operational source of truth. The planned hybrid is DynamoDB online plus sanitized, checkpointed S3 exports queried with Athena. Athena and exports are not implemented. Never synchronously dual-write one fact to two databases.

Add Aurora PostgreSQL only after join-heavy requirements such as organization entitlements, billing, collaborative rubric authoring, or multi-entity constraints are demonstrated.

## 11. Privacy and retention

- P0 mock state stays in browser memory.
- P1 persists transcript, code, canvas, scenario, usage, manifests, and reports in DynamoDB.
- Invited guests' evidence is retained until deletion; per-session deletion ships in Phase 2 and full account export remains deferred.
- Audio is not recorded, uploaded, or stored by the application; there is no recording bucket or upload endpoint.
- Operational logs and analytics must not receive interview content or credentials.
- Phase 1 remains an invite-only pilot; general public use requires additional privacy and reliability work.

## 12. Observability

Every stage has safe API access logs, strict Lambda JSON logs, native service metrics, and active X-Ray tracing. Access logs contain request ID, route, status, integration latency and response bytes, without headers or bodies. Lambda logs use hashed session references and allowlisted metadata, without interview content or credentials. Log retention is seven days outside production and 30 days in production.

Only `prod` (also recognized internally as `production`) creates:

- Eight single-metric alarms: API 5xx; errors for the four Lambdas; DLQ depth; `grading_failed`; `session_setup_failed`. Every alarm notifies the SNS email topic configured with `ALERT_EMAIL`.
- One dashboard and one $1 monthly AWS Budget, emailing at 80% forecast and 100% actual spend.
- Eight emitted EMF metrics: `session_setup_ms`, `session_setup_failed`, `interview_completed`, `idempotency_conflict`, `grading_latency_ms`, `grading_schema_failure`, `evidence_reference_invalid`, `grading_failed`.

Four additional metric names are reserved, not emitted end to end: reconnect, provider-error, abandonment, and measured Gemini cost. The cap counts emitted metric/dimension combinations, not enum names; current call sites use fixed production/application dimensions. Never exceed 10 emitted custom metrics or 10 alarm metrics per account. EMF is written at the JSON root through stdout.

Development has zero custom metrics, alarms, dashboards, or budgets. CDK assertions enforce the monitoring/resource limits. SNS and SQS require TLS. Live alarm delivery, subscription confirmation, budget configuration, and measured usage are owner-run deployment checks. BFF reads return sanitized errors; richer server-side proxy diagnostics are deferred.

## 13. Cost model

The following numbers are the v2 spec's planning estimates, not measured bills or a guaranteed price ceiling. The objective is about $5/month all-in, with AWS near zero; quotas limit sessions rather than charging a fixed amount per session. Recheck provider prices (V5) and account-wide free-tier eligibility before deployment.

| Item | Expected/month | Planning worst case at caps |
|---|---:|---:|
| Gemini Live voice, at most 10 × 10 minutes | $3.00–4.50 | about $6.00 |
| Gemini text, at most 60 sessions (Phase 2) | $0.10–0.60 | about $2.40 |
| Gemini grading | < $0.25 | < $0.50 |
| AWS application plane | $0.00–0.30 | < $1.00 |
| Eligible Vercel Hobby | $0 | $0 |
| **Total** | **about $3.35–5.65** | **about $9.90** |

SSM standard Parameter Store replaces a recurring secret-store charge. Production-only monitoring is sized to the account's free-tier allowance; unrelated resources can consume that allowance. DynamoDB on-demand, PITR, logs, traces, and provider context rebilling still require billing verification.

After the first month, measure voice cost per session; if it exceeds $0.40, lower `VOICE_GLOBAL_MONTHLY_LIMIT` to keep the expected total near $5. Google billing alerts at $3 and $5 and the $1 AWS Budget warn but do not stop spending. The atomic quotas and credential/session limits enforce usage caps.

No WAF, NAT gateway, managed Grafana/Prometheus, Aurora, or always-on containers belong in this pilot. A future larger deployment needs a new measured cost model and architecture approval before caps rise.

Price verification sources: [Gemini](https://ai.google.dev/gemini-api/docs/pricing), [AWS](https://aws.amazon.com/pricing/), and [Vercel](https://vercel.com/pricing).

## 14. CI/CD

Use Node.js 22 and **pnpm 11.19.0 exactly**. Normal installs use `pnpm install --frozen-lockfile`; intentional dependency changes own a separate reviewed lockfile commit. The one-day release-age gate and exact reviewed exceptions remain enforced. Range overrides patch vulnerable js-yaml and smol-toml paths without lowering the moderate-severity audit threshold.

GitHub Actions has quality, infrastructure, and browser jobs. Quality runs the dependency audit, lint, typecheck, Jest coverage, production build, and client-bundle secret scan. Infrastructure runs tests and test-stage synthesis. Browser depends on both and runs the Chromium mock journey. Actions are SHA-pinned; CodeQL, dependency review, and Dependabot supplement CI. Require all three CI jobs green before merging lane PRs into `feature/v2-phase1` and before the owner approves the integration PR into `main`.

Only GitHub environments `development` and `production` are used, mapping to CDK stages dev/prod. Development auto-deploys from a successful trusted main push only when `P1_AWS_DEPLOY_ENABLED=true`. Production is manual, main-only, reviewer-gated, and requires successful push CI on the selected revision. Leave automatic deployment disabled until the owner completes setup. GitHub OIDC supplies temporary AWS credentials.

Deployment inputs are AWS_DEPLOY_ROLE_ARN, AWS_REGION (ap-southeast-1), P1_ALLOWED_ORIGIN, the six VOICE/TEXT monthly-limit variables, VOICE_SESSION_MINUTES, and production secret ALERT_EMAIL. Optional P1_HEALTHCHECK_URL/P1_SMOKE_PATH configure the anonymous smoke. Cap validation runs during synthesis. The owner creates the stage SecureString separately; no standard Gemini key enters GitHub or Lambda environment variables.

Deploy AWS before Vercel and keep `/v1` backward compatible. Vercel uses the manual exact-revision verify-then-promote workflow, with credentials scoped to CLI steps; there is no coordinated two-plane rollback. Cloud deployment and credential handling remain the owner's Task 16 checkpoint.

## 15. Testing contract

No automated test calls real AWS or Gemini. Mock SDK/provider boundaries; synthesize with stage=test. Task 15 verifies 87 application tests across 19 suites, 113 infrastructure tests across 11 suites, and one Chromium candidate journey. The integration PR records the exact verified revision and GitHub Actions results.

Application tests cover lifecycle/cost/scorecards, evidence schemas/retries, account/report contracts, PKCE/state/cookies, origin/body guards, safe logs, BFF response validation, and secret non-disclosure. Infrastructure tests cover access policies and caps, idempotent reservations, history transactions, account IDOR/cursor isolation, grader outcomes and index-write failures, cached SSM reads, production-only EMF, and synthesized auth/IAM/monitoring restrictions.

Playwright exercises one deterministic mock candidate journey using a stubbed session response against the production UI. Real microphone/provider behavior, Cognito claims, billing, and deployed permissions require the owner checkpoint. No mock test proves those live properties.

Task 15 also reviews the Phase 1 diff against OWASP A01–A10. Existing source-size exceptions are interview-app.tsx (574 lines, split in Phase 2) and event-handler.ts (457 lines, existing near-limit exception). Hand-written config validation remains an explicit allowlist boundary. Broader BFF diagnostics and unused-type cleanup are deferred.

## 16. Acceptance and SLOs

Local acceptance:

- pnpm lint;
- pnpm typecheck;
- pnpm audit:deps;
- pnpm test:ci;
- pnpm infra:test;
- pnpm infra:synth --context stage=test;
- pnpm build;
- pnpm security:bundle;
- pnpm test:e2e;
- pnpm audit:prod; and
- generated client assets contain no Gemini standard key.

Post-deployment targets:

- p95 session setup below 3 seconds;
- p95 end-of-speech to first interviewer audio below 1.5 seconds;
- at least 95% completion;
- at least 99% planned reconnect success after reconnect UX ships; and
- current-pilot expected spend around $5/month, measured after deployment and future cost below $2.50/completed interview.

Required before public production: deletion/export, privacy consent, reconnect recovery, provider/authenticated E2E tests, budget alerts, abuse review, backward-compatible AWS-first promotion/rollback procedures, and a 25-concurrent-session load test.

## 17. Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-01 | Use Gemini for live interviewing and independent grading | Lower cost and simpler boundaries |
| 2026-09-01 | Keep mock mode first class | Local work and CI stay deterministic and free |
| 2026-09-01 | Keep audio direct to Gemini | Lowest latency and no AWS media relay |
| 2026-09-01 | Use DynamoDB online | Current access patterns do not justify relational infrastructure |
| 2026-09-01 | Use CloudWatch/X-Ray without Prometheus | Serverless resources publish native signals |
| 2026-09-02 | Make Vercel primary and Amplify a manual fallback | Next.js 16 exceeds Amplify's documented managed support |
| 2026-09-02 | Put Cognito tokens behind a BFF | Keeps bearer tokens out of browser JavaScript |
| 2026-09-02 | Enforce 10 × 10-minute pilot limits | Bounds spend while collecting real data |
| 2026-09-02 | Reserve event ID and sequence transactionally | Makes retries and reconnect reordering safe |
| 2026-09-02 | Lease grading before Gemini | Prevents duplicate paid grading |
| 2026-09-02 | Pin AWS to Singapore | Prevents AWS-profile region drift |
| 2026-09-02 | Use production Lambda aliases and 10%/5-minute canaries | Makes elevated-error rollouts automatically reversible |
| 2026-09-02 | Fail closed when P1 is absent in production | Keeps the unauthenticated developer-only Gemini route off public hosts |
| 2026-09-02 | Persist one short-lived response per idempotency key | Prevents retry races from minting multiple paid provider credentials |
| 2026-09-02 | Re-enqueue duplicate completion evidence | Repairs the database-to-queue delivery gap while the grader lease deduplicates spend |
| 2026-09-02 | Enforce dependency age, immutable actions, and moderate audit gates | Reduces CI supply-chain exposure, including development tooling |
| 2026-09-24 | Keep Vercel + lean AWS; defer OpenNext | Least rework, keeps the AWS portfolio boundary |
| 2026-09-24 | Invite-only Cognito owner/guest groups | Shareable access with bounded paid usage |
| 2026-09-24 | Separate voice (≤10) and text (≤60) monthly allowances | Voice is scarce; text support arrives in Phase 2 |
| 2026-09-24 | Replace Secrets Manager with SSM SecureString and five-minute cache | Reduce recurring costs while allowing key rotation |
| 2026-09-24 | Prod-only monitoring: 8 alarms, 8 emitted metrics, SNS email, $1 budget | Free-tier allowances are account-wide; alarms need notification actions |
| 2026-09-24 | Remove CodeDeploy canaries, staging, recording S3 bucket, and Amplify | Reduce unused solo-maintenance overhead |
| 2026-09-24 | Grant underlying DynamoDB item actions | Transactions authorize their item operations, not a TransactWriteItems IAM action |
| 2026-09-24 | Add ownership-checked account/report reads and derived history | Expose stored results while preserving tenant isolation and grading idempotency |
| 2026-09-24 | Restore all CI gates before integration | Patch vulnerable build dependencies without bypassing audit policy |
