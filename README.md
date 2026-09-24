# Signal Room — AI Technical Interview Coach

[![CI](https://github.com/AloysiusLimMingZhou/signal-room-interview-coach/actions/workflows/ci.yml/badge.svg)](https://github.com/AloysiusLimMingZhou/signal-room-interview-coach/actions/workflows/ci.yml)

Signal Room is a Gemini-first interview practice app. Transcript, code, and architecture artifacts become evidence for independent grading. The local P0 prototype runs without keys or cloud accounts; v2 Phase 1 adds an invite-only pilot on Vercel and a lean AWS backend in Singapore.

**Deployment state:** implemented and tested locally/through GitHub Actions; the owner-run first deployment checkpoint is still outstanding. The browser currently shows a deterministic scorecard. The stored Gemini report is available through the authenticated API; report/history UI and the real question-aware interview loop ship in Phase 2.

**Phase 2 development:** the [implementation plan](./docs/superpowers/plans/2026-09-24-signal-room-v2-phase2.md), ten versioned Coding/Behavioral questions, question selection, and shared voice/text interviewer builder are in place. These foundations are tested independently; wiring them into sessions and the web experience is the next step.

[architecture.md](./architecture.md) is the source of truth for boundaries, contracts, security, costs, and deployment. The [v2 spec](./docs/superpowers/specs/2026-09-15-signal-room-v2-design.md) and [Phase 1 plan](./docs/superpowers/plans/2026-09-16-signal-room-v2-phase1.md) describe the roadmap and checkpoint.

## What works

- System-design, ML-design, and algorithm tracks at mid/senior/staff difficulty; XState lifecycle, Monaco workbench, and structured design canvas.
- Deterministic mock mode and Gemini Live adapters; 16 kHz input and 24 kHz output audio directly between browser and Gemini.
- Cognito code + PKCE authentication; access tokens stay in an HttpOnly cookie scoped to `/api`.
- Invite-only `owner`/`guest` groups with no self sign-up. An ungrouped account cannot create sessions (`403 account_not_enabled`).
- Atomic voice quotas, retry-safe session creation, and append-only evidence batches.
- Per-channel allowance configuration: voice global ≤10/month (owner 10, guest 2), text global ≤60/month (owner 60, guest 5). Actual text interviews arrive in Phase 2.
- SQS grading with a DynamoDB lease, terminal failure handling, and derived session history.
- Authenticated account, history, and stored-report reads, with ownership checks and validated BFF responses.
- SSM SecureString key storage with a five-minute cache; production-only alarms, dashboard, custom metrics, SNS email, and a $1 AWS budget.
- Nonce CSP, exact-origin checks, bounded input, safe error bodies, and content-free operational logs.

## Architecture

~~~mermaid
flowchart LR
  Browser[Candidate browser] --> BFF[Next.js 16 BFF on Vercel]
  BFF <-->|code + PKCE| Cognito[Cognito owner/guest groups]
  BFF --> API[HTTP API + JWT authorizer]
  API --> Session[Session Lambda]
  API --> Events[Event Lambda]
  API --> Account[Account Lambda]
  Session --> DB[(DynamoDB)]
  Events --> DB
  Account --> DB
  Session --> Key[SSM SecureString]
  Session --> Token[Gemini token service]
  Token --> Browser
  Browser <-->|direct audio WebSocket| Live[Gemini Live]
  Events --> Queue[SQS + DLQ]
  Queue --> Grader[Grader Lambda]
  Grader --> Key
  Grader --> Grade[Gemini text grader]
  Grader --> DB
~~~

Audio never passes through AWS. A standard Gemini key never reaches the browser or a `NEXT_PUBLIC_*` variable. All AWS resources are pinned to `ap-southeast-1`.

## Run locally

Use Node.js 22 and **pnpm 11.19.0 exactly**:

~~~bash
pnpm --version
pnpm install --frozen-lockfile
pnpm dev
~~~

Open `http://localhost:3000`. Without `.env.local`, the app uses mock mode and does not request microphone access or call Gemini. A failed frozen install must be investigated; do not regenerate the lockfile as a fallback.

Optional developer-only Live mode uses a server-only `GEMINI_API_KEY` in an ignored `.env.local`. Never expose that unauthenticated development path publicly. Production without `P1_API_URL` fails closed with 503.

## Account API

| BFF route | Purpose |
|---|---|
| `GET /api/me` | Signed-in role and voice/text allowances with UTC reset time |
| `GET /api/sessions?limit=20&cursor=...` | Newest-first session history, maximum 50 items per page |
| `GET /api/sessions/[id]/report` | `pending`, `grading`, `complete`, or `failed`; version 1 report when complete |

The AWS equivalents use `/v1/me`, `/v1/sessions`, and `/v1/sessions/{sessionId}/report`. Missing and other-user sessions return the same 404 before a report is read. Cursors are confined to the caller's history partition. Responses are strictly Zod-validated and non-cacheable. History is a derived index; the stored report remains authoritative.

Set optional server-only `CONTACT_URL` to an HTTPS or mailto request-access destination. The sign-in screen omits the link when no valid value is configured. An ungrouped caller can inspect zero allowances but cannot start an interview.

## Verification

~~~bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm audit:deps
pnpm audit:prod
pnpm test:ci
pnpm infra:test
pnpm infra:synth --context stage=test
pnpm build
pnpm security:bundle
pnpm exec playwright install chromium
pnpm test:e2e
~~~

Tests mock AWS/Gemini boundaries and incur no provider spend. The suite has **98 application tests**, **118 infrastructure tests**, **four interviewer snapshots**, and **one Chromium candidate journey**. The browser test stubs session provisioning and exercises the production UI. See the integration PR for the exact verified revision and GitHub Actions results.

Regression coverage includes role/cap boundaries, raced session creation, cursor tampering, report ownership, corrupt reports, grading failures, best-effort history writes, read-only account permissions, exact CORS, SSM/KMS scope, and production monitoring. Real Cognito claims, audio behavior, deployed permissions, and billing remain manual checks.

## First deployment checkpoint — owner only

Run Task 16 after the integration PR is approved and merged into `main`. Agents do not create cloud resources or handle cloud credentials. Use the owner's normal AWS authentication outside this task.

1. Bootstrap CDK once for the target account:

   ~~~bash
   pnpm exec cdk bootstrap aws://ACCOUNT_ID/ap-southeast-1
   ~~~

2. Create the standard-tier SSM SecureString `/signal-room/dev/gemini-api-key` with the AWS-managed `aws/ssm` key, using the AWS console or the plan's POSIX-shell command below. Enter the key interactively in a shell without tracing or recording; do not commit it or place it in GitHub variables.

   ~~~bash
   read -rs GEMINI_KEY
   aws ssm put-parameter --region ap-southeast-1 --name /signal-room/dev/gemini-api-key --type SecureString --value "$GEMINI_KEY"
   unset GEMINI_KEY
   ~~~

   CloudFormation does not create the SecureString value. Lambdas receive only `GEMINI_KEY_PARAMETER_NAME`, and permission to read that stage's parameter through SSM.

3. Deploy dev with one exact allowed origin. PowerShell example:

   ~~~powershell
   $env:DEPLOY_STAGE = "dev"
   $env:P1_ALLOWED_ORIGIN = "http://localhost:3000"
   pnpm infra:deploy --context stage=dev
   ~~~

   Outputs: `ApiUrl`, `UserPoolId`, `UserPoolClientId`, `CognitoDomain`, and `GeminiKeyParameterName`. Production additionally outputs `DashboardName`.

4. Invite the owner (Cognito emails a temporary password):

   ~~~powershell
   ./scripts/invite-user.ps1 -UserPoolId <UserPoolId> -Email <your-email> -Group owner
   ~~~

   POSIX equivalent: `./scripts/invite-user.sh <UserPoolId> <your-email> owner`.

5. Configure the ignored local BFF environment, start the app, sign in, and set a permanent password:

   ~~~dotenv
   P1_API_URL=https://the-api-id.execute-api.ap-southeast-1.amazonaws.com
   APP_ORIGIN=http://localhost:3000
   COGNITO_CLIENT_ID=the-UserPoolClientId-output
   COGNITO_DOMAIN=https://the-CognitoDomain-output
   ~~~

   Do not configure a standard Gemini key on the P1 Vercel project. The BFF only receives constrained ephemeral credentials from AWS.

6. Check `/api/me` returns `owner` (verification V4). Complete a real voice interview, then use `/api/sessions` and `/api/sessions/<id>/report` to confirm a complete report and graded history. Record setup/grading latency. Verify a guest's third voice session is rejected and an ungrouped account gets the invite-only 403. Use dev for these quota tests.

7. Create the prod SecureString, configure the production environment below, deploy AWS first, confirm the SNS email subscription, and then deploy Vercel with the exact production origin. Verify all five API routes require authentication and the account/report flow works.

8. Configure a Google billing budget with $3/$5 alerts and restrict the key to the Generative Language API. Verify the $1 AWS Budget and alarm delivery. Record results and outstanding probes in an architecture decision-log PR; do not record keys, tokens, or interview content.

V1–V3 (Live resumption uses, tool support, and control-event behavior), V5 (current prices), and V6 (browser capture sample rate) must be resolved before Phase 2 depends on them. Tests do not answer these live integration questions.

## GitHub CI/CD

The `quality`, `infrastructure`, and `browser` jobs must all pass before every lane merge. The dependency audit includes development tooling and rejects moderate-or-higher vulnerabilities; release-age controls and immutable action pins remain enabled. The audit fix upgrades js-yaml/smol-toml across vulnerable paths without bypassing the gate. Dependency review, CodeQL, and Dependabot supplement CI.

Only two GitHub environments are used: **development** and **production**, mapping to CDK dev/prod. Configure:

- `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION=ap-southeast-1`, and exact `P1_ALLOWED_ORIGIN` as environment variables.
- Monthly allowance variables: `VOICE_GLOBAL_MONTHLY_LIMIT=10`, `VOICE_OWNER_MONTHLY_LIMIT=10`, `VOICE_GUEST_MONTHLY_LIMIT=2`, `TEXT_GLOBAL_MONTHLY_LIMIT=60`, `TEXT_OWNER_MONTHLY_LIMIT=60`, `TEXT_GUEST_MONTHLY_LIMIT=5`.
- `VOICE_SESSION_MINUTES=10`; limits can be lowered but cannot exceed the documented hard caps.
- Production secret `ALERT_EMAIL`, used for both the AWS Budget and SNS subscription.
- Optional `P1_HEALTHCHECK_URL` and `P1_SMOKE_PATH`.

Leave repository variable `P1_AWS_DEPLOY_ENABLED` unset until the owner configures development. Setting it to `true` enables dev deployment after successful CI on trusted main pushes. Manual runs require successful CI on the selected revision; production requires push CI on that exact main revision and a reviewer-gated production environment. OIDC supplies temporary AWS credentials.

For Vercel, configure production variables `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` and secret `VERCEL_TOKEN`, plus the four BFF variables in the Vercel project. Run `deploy-vercel.yml` manually from main after the matching AWS deployment is healthy. It builds a candidate, verifies health/auth configuration, and promotes the exact artifact. Disable Vercel Git auto-deployments if this workflow is authoritative. Keep `/v1` backward compatible and deploy AWS before Vercel.

## Cost and privacy limits

The v2 spec estimates roughly **$3.35–5.65/month**, with a planning worst case around **$9.90** at the caps. These are estimates, not measured bills or a guaranteed dollar ceiling. Voice is expected to dominate; the text allowance is reserved for Phase 2. Verify current pricing and account-wide AWS free-tier usage at deployment.

Production has eight single-metric alarms, one dashboard, and eight emitted custom metrics; four metric names are reserved and not emitted. Development emits no custom metrics and creates no alarms/dashboard/budget. The maximum is 10 alarm metrics and 10 emitted custom metric/dimension combinations per account.

After the first month, lower the global voice cap if measured cost exceeds $0.40/session. Budgets notify; they do not stop spending. The browser stops at ten wall-clock minutes, with a provider credential ceiling of twelve minutes including reconnect margin. See [architecture.md](./architecture.md) for the cost table and boundaries.

Audio is not recorded or uploaded. Invited users' evidence and reports remain in DynamoDB until deletion; per-session deletion ships in Phase 2, and full account export remains deferred. Operational logs reject content and credentials. General public use requires further privacy, reconnect, abuse, and deployed reliability checks.

## Next steps

1. Complete the owner-run Task 16 deployment checkpoint and record actual results.
2. Continue the Phase 2 plan: wire the question bank/shared interviewer, `view_code`, text channel, real report/history UI, and deletion; incorporate the owner's live verification results before claiming deployment readiness.
3. Add Phase 3 differentiators: grader evaluations, browser Python tests, delivery analytics, measured operational metrics, and a real-session demo replay.
