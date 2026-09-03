# Architecture: Signal Room AI Technical Interview Coach

**Status:** Source of truth

**Last updated:** 2026-09-02

**Owner:** Project engineering

**Target:** Web-only P0 local prototype plus P1 access-controlled indie pilot
**Deployment state:** Implemented and locally verified; cloud resources are not yet deployed

## 1. Authority and change policy

This document defines the accepted product scope, runtime boundaries, provider integration, persisted contracts, privacy rules, security controls, tests, cost limits, and delivery model. When code and this document disagree, this document wins until both are updated together.

An architecture-changing pull request must update this file and the decision log, update affected schemas and tests, state migration effects, and preserve deterministic mock mode for local development and CI.

## 2. Product boundary

Signal Room is a candidate-facing technical interview coach. It is not an employer screening or automated hiring product.

### P0 local mode

P0 works without credentials or cloud services:

- choose system-design, ML-design, or algorithms and a difficulty;
- complete a text-driven mock interview;
- edit code in Monaco and build a structured design canvas;
- inject a changing requirement;
- finish with an evidence-linked scorecard; and
- view a planning cost estimate.

State is held in browser memory and reloads are destructive.

### P1 indie pilot

P1 adds:

- Cognito sign-in using authorization code plus PKCE;
- constrained, short-lived Gemini Live credentials;
- a global hard cap of **10 interviews per UTC month**;
- a per-user cap no greater than the global cap;
- a maximum duration of **10 minutes per interview**;
- append-only transcript, code, canvas, scenario, usage, and lifecycle evidence;
- asynchronous independent grading with evidence references persisted to DynamoDB; and
- CloudWatch logs, metrics, dashboard, alarms, and X-Ray traces.

The P1 grader is wired through storage and the queue, but the browser still renders the immediate deterministic scorecard. An authenticated report-read API and browser polling are required before the Gemini-generated report is user-visible.

The hard caps are enforced in deployment configuration and in an atomic DynamoDB transaction. Raising them is an architecture change, not an environment-variable-only change.

The current system excludes webcam analysis, emotion or accent scoring, covert proctoring, hire/no-hire judgments, payments, server-side arbitrary code execution, and mobile delivery.

## 3. Architectural principles

1. **Gemini ecosystem first.** One Gemini Live session conducts the interview; a separate Gemini text call grades frozen evidence.
2. **Audio bypasses AWS.** The browser connects directly to Gemini Live after receiving a constrained credential.
3. **Secrets stay server-side.** The standard Gemini key is never sent to client code or browser storage.
4. **The web server is a BFF.** Cognito access tokens remain in a scoped HttpOnly cookie and are attached to AWS API calls only by Next.js route handlers.
5. **Evidence is append-only.** Events have stable IDs, sequence numbers, strict schemas, and retry-safe writes.
6. **Independent grading is idempotent.** Completion retries do not enqueue duplicate work, and the grader takes a DynamoDB lease before a paid model call.
7. **No evidence in operational logs.** Transcripts, code, canvas content, audio, resumes, cookies, authorization headers, and credentials are rejected by the logging schema.
8. **Known access patterns first.** DynamoDB serves online state; relational infrastructure waits for demonstrated requirements.
9. **Cost is a product invariant.** Quotas bound usage, while measured provider billing decides later scaling.

## 4. Runtime topology

~~~mermaid
flowchart LR
  subgraph Browser[Candidate browser]
    UI[Next.js interview workbench]
    State[XState lifecycle]
    Code[Monaco]
    Canvas[Structured canvas]
    Audio[AudioWorklet]
    Adapter[Gemini or mock adapter]
  end

  subgraph Web[Vercel-hosted Next.js BFF]
    Auth[/api/auth/*]
    Session[/api/realtime/session]
    Events[/api/interview-events]
  end

  subgraph AWS[AWS ap-southeast-1]
    Cognito[Cognito Hosted UI]
    API[API Gateway HTTP API + JWT authorizer]
    SessionFn[Session Lambda]
    EventFn[Event Lambda]
    DB[(DynamoDB)]
    Queue[SQS + DLQ]
    Grader[Grader Lambda]
    Secret[Secrets Manager]
    Bucket[(Private S3 boundary)]
    Obs[CloudWatch + X-Ray]
  end

  subgraph Google[Google Gemini]
    Token[Ephemeral-token service]
    Live[Gemini Live WebSocket]
    Grade[Gemini text grader]
  end

  UI --> State
  Code --> State
  Canvas --> State
  Audio --> Adapter
  Browser --> Auth
  Auth <-->|OAuth code + PKCE| Cognito
  Browser --> Session
  Browser --> Events
  Session -->|HttpOnly access token| API
  Events -->|HttpOnly access token| API
  API --> SessionFn
  API --> EventFn
  SessionFn --> DB
  SessionFn --> Secret
  SessionFn --> Token
  Token -->|constrained token| SessionFn
  SessionFn --> Session
  Adapter <-->|direct 16 kHz input / 24 kHz output| Live
  EventFn --> DB
  EventFn --> Queue
  Queue --> Grader
  Grader --> Secret
  Grader --> Grade
  Grader --> DB
  API --> Obs
  SessionFn --> Obs
  EventFn --> Obs
  Grader --> Obs
  Bucket -.->|recording upload is deferred| Browser
~~~

When P1_API_URL is unset in development or test, the BFF keeps the local P0 path. When GEMINI_API_KEY is also unset, session creation returns a mock descriptor and no external provider is contacted. A production build without P1_API_URL fails closed with 503; it never exposes the unauthenticated local mock/Gemini route.

## 5. Component decisions and implementation status

| Area | Decision | Status |
|---|---|---|
| Web | Next.js App Router, React, TypeScript | Implemented |
| Lifecycle | XState | Implemented |
| Code/design surfaces | Monaco plus lightweight structured canvas | Implemented; Excalidraw deferred |
| Styling | Project-owned CSS | Implemented; Tailwind/shadcn deferred |
| Provider boundary | Mock and Gemini adapters | Implemented |
| Frontend host | Vercel | Primary deployment target |
| AWS application plane | CDK, API Gateway HTTP API, ARM Node.js 22 Lambda | Implemented, not deployed |
| Identity | Cognito Hosted UI, OAuth code + PKCE | Implemented, not deployed |
| Online data | DynamoDB on-demand single table | Implemented, not deployed |
| Async work | SQS, DLQ, Lambda grader | Implemented, not deployed; report-read UI deferred |
| Object boundary | Private encrypted S3, 30-day recordings/ lifecycle | Provisioned only; no upload route/UI |
| Operations | CloudWatch logs/EMF metrics/dashboard/13 baseline alarms, X-Ray | Implemented, not deployment-tested |
| Lambda release | Production aliases and CodeDeploy 10%/5-minute canaries | Implemented, not deployment-tested |
| Analytics SQL | S3 Parquet + Athena | Deferred |
| Grafana/Prometheus | Not needed for serverless P1 | Deferred |
| WAF, AWS Budgets, EventBridge jobs | Production hardening | Deferred |

AWS Amplify is a manual compatibility-gated fallback. Its documented managed SSR support currently covers Next.js through version 15, while this repository uses Next.js 16; see [Amplify Next.js support](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html).

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
- P1 session and grader Lambdas read the key from Secrets Manager.
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

## 9. DynamoDB model and consistency

| Entity | PK | SK |
|---|---|---|
| Session manifest | SESSION#sessionId | META |
| Evidence event | SESSION#sessionId | EVENT#zero-padded-sequence |
| Event-ID reservation | SESSION#sessionId | EVENT_ID#eventId |
| Report / grading lease | SESSION#sessionId | REPORT#P1#v1 |
| Request idempotency | USER#cognito-sub | SESSION_REQUEST#key |
| Short-lived session response | USER#cognito-sub | SESSION_RESPONSE#key |
| Global quota | QUOTA#GLOBAL | MONTH#YYYY-MM |
| User quota | QUOTA#USER#cognito-sub | MONTH#YYYY-MM |

Session creation atomically increments both quota counters and writes idempotency/session records. Event writes atomically advance the sequence high-water mark and reserve sequence and event ID. The Cognito subject must match the session owner.

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
- Evidence is retained until deletion, but user-facing delete/export is not implemented. P1 remains an access-controlled pilot, not a public production service.
- Audio is not uploaded or stored by the current app.
- The private S3 bucket prepares an opt-in recording boundary and deletes both current and noncurrent versions under recordings/ after 30 days; consent/upload code is deferred.
- Operational logs and analytics must not receive content-bearing evidence or credentials.

## 12. Observability

The baseline is CloudWatch-native because the serverless resources have no Prometheus scrape requirement.

Implemented:

- API Gateway JSON access logs with request ID, route, status, integration latency, response bytes, and authorizer outcome; no headers or bodies.
- Strict Lambda logs with safe results, durations, request/trace IDs, hashed session references, and allowlisted low-cardinality metadata.
- EMF metrics written as root JSON documents directly to Lambda stdout for session setup, completion, grading latency/schema failures, invalid evidence references, and idempotency conflicts.
- Native API Gateway, Lambda, DynamoDB, and SQS metrics.
- One dashboard and 13 baseline alarms covering API errors/latency, Lambda errors/throttles, DynamoDB throttles/system errors, queue age, and DLQ depth.
- Production adds three alias error alarms and CodeDeploy shifts 10% traffic for five minutes before completing each Lambda rollout; an alarm, failed deployment, or stopped deployment rolls back.
- Seven-day non-production and 30-day production log retention.
- Active X-Ray tracing.

Reconnect, provider-error, abandonment, and measured-cost metrics are reserved but not emitted end to end. OpenTelemetry SDK instrumentation, sampling rules, spend alarms, synthetic alarm exercises, and Grafana are deferred. Managed Prometheus should wait for stable Prometheus-native workloads.

## 13. Cost model

Pricing is a dated estimate checked on 2026-09-01. Actual Gemini usage records and AWS/Vercel bills are authoritative. A Gemini API key has no fixed fee.

### Current 10 × 10-minute indie pilot

Assume each interview contains about 6.7 candidate-audio minutes and 2.2 interviewer-audio minutes.

~~~text
Per-session audio-only lower bound
= 6.7 × $0.005 + 2.2 × $0.018
≈ $0.073

Ten-session audio-only lower bound ≈ $0.73/month
~~~

Accumulated context is rebilled, so plan **$3–$6/month** for Gemini Live across all ten sessions. Independent Flash-Lite grading should remain below **$0.25/month** at this volume.

| Cost center | Ten-session estimate |
|---|---:|
| Vercel Hobby for an eligible student/non-commercial project | $0 |
| Cognito direct email sign-in, no SMS | $0 at this volume |
| API Gateway HTTP API | < $0.01 |
| Lambda | < $0.01, usually free-tier covered |
| DynamoDB on-demand | < $0.05 |
| S3 and transfer | < $0.10; no audio uploads today |
| SQS and DLQ | < $0.01 |
| Secrets Manager | about $0.40 |
| CloudWatch/X-Ray/dashboard/13 alarms/custom metrics | about $2–$6 |
| **AWS application plane** | **about $2.50–$7/month** |
| **Gemini + AWS + eligible Vercel Hobby** | **about $5.75–$13.25/month** |

Do not add WAF, Managed Grafana, Managed Prometheus, NAT Gateway, Aurora, or always-on containers to the indie profile. Configure Google and AWS budget notifications before enabling the key. Quotas do not replace billing alerts.

### Future 1,000 × 45-minute scenario

This is a future model, not the deployable cap.

| Cost center | Monthly estimate |
|---|---:|
| Gemini Live | $1,500–$1,800 |
| Independent grading | $5–$15 |
| AWS production stack | $32–$117 |
| AWS all environments | $75–$200 |
| Gemini-first all-in | $1,580–$2,015 |

Before raising the cap, measure context rebilling, p95 latency, reconnect reliability, event volume, and grading quality. The future target remains below $2.50 per completed interview.

References: [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [API Gateway](https://aws.amazon.com/api-gateway/pricing/), [Lambda](https://aws.amazon.com/lambda/pricing/), [DynamoDB](https://aws.amazon.com/dynamodb/pricing/), [CloudWatch](https://aws.amazon.com/cloudwatch/pricing/), and [Vercel](https://vercel.com/pricing).

## 14. CI/CD

CI runs a frozen lockfile install, a moderate-or-higher audit across production and build dependencies, ESLint, TypeScript, Jest coverage, production build, a post-build client-secret scanner, infrastructure Jest/CDK synth, and Playwright Chromium. The browser test stubs only session provisioning, so the production server can retain its fail-closed P1 policy while the deterministic candidate journey remains free. CodeQL, pull-request dependency review, and grouped Dependabot updates are separate. Third-party actions are pinned to full commit SHAs, and pnpm enforces a one-day minimum package release age except for the exact reviewed Vercel CLI release set recorded in the lockfile.

deploy-p1-aws.yml accepts a successful trusted main push for automatic development deployment only when the repository variable P1_AWS_DEPLOY_ENABLED is exactly true; it remains dormant by default while credentials and environment variables are absent. A manually selected environment remains available and fails closed when its configuration is incomplete. The workflow uses GitHub OIDC, pins Singapore, revalidates hard caps, requires successful CI for every manually selected revision, tests/synthesizes/diffs before deploy, uploads artifacts, and verifies the API authorizer rejects an anonymous request. Production additionally requires a successful push-triggered CI run for that exact revision and should be protected by a required-reviewer GitHub environment.

Vercel is the primary web target. Automatic Vercel production deployment is disabled until an authenticated integration smoke and coordinated two-plane promotion/rollback exist; otherwise the production web could outrun the AWS contract. A manual release must deploy and validate the matching AWS production stack before promoting the web artifact. Vercel credentials must be scoped only to its CLI steps.

deploy-amplify.yml is manual-only and requires explicit Next.js 16 compatibility confirmation.

## 15. Testing contract

No automated test may use a real Gemini key or incur provider spend.

Jest covers cost/state/report behavior; P1 schemas, quotas, idempotency and reordering; evidence retry behavior; redaction and metric cardinality; origin/body guards; PKCE/state/cookies; BFF routes and secret non-disclosure; grading deduplication and queue-loss recovery; and CDK auth, encryption, IAM, retention, logs, alarms, and recovery settings. The current local suite has 58 application tests and 23 infrastructure tests. Playwright adds one end-to-end candidate-flow test.

Playwright covers the full mock candidate flow, code/canvas tabs, scenario injection, completion, and report. Authenticated P1, real microphone/provider, reconnect, quota, and cloud-failure browser tests are post-deployment work.

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
- current-pilot spend below $25/month and future cost below $2.50/completed interview.

Required before public production: deletion/export, privacy consent, reconnect recovery, provider/authenticated E2E tests, budget alerts, abuse review, coordinated two-plane promotion/rollback, and a 25-concurrent-session load test.

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
