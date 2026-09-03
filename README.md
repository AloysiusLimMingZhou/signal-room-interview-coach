# Signal Room — AI Technical Interview Coach

[![CI](https://github.com/AloysiusLimMingZhou/signal-room-interview-coach/actions/workflows/ci.yml/badge.svg)](https://github.com/AloysiusLimMingZhou/signal-room-interview-coach/actions/workflows/ci.yml)

Signal Room is a Gemini-first web app for practicing system-design, ML-design, and algorithm interviews. It treats transcript, code, and architecture artifacts as evidence, then creates a scorecard tied to that evidence.

The deterministic P0 prototype runs locally with no key or cloud account. The P1 indie-pilot code adds Cognito authentication, a Next.js BFF, a hard 10-interview × 10-minute monthly limit, DynamoDB evidence, asynchronous Gemini grading, CloudWatch operations, and guarded GitHub deployments. P1 is implemented and locally verified but has not been deployed to AWS or Vercel.

## Source of truth

[architecture.md](./architecture.md) is authoritative for product scope, provider boundaries, data contracts, privacy, costs, testing, and deployment. Architecture changes must update it and the related tests in the same pull request.

## What works

- System-design, ML-design, and algorithm tracks at mid, senior, and staff difficulty.
- XState interview lifecycle with deterministic mock and Gemini adapters.
- Monaco code workbench and structured design canvas.
- Dynamic scenario injection and an evidence-linked local scorecard.
- Direct browser-to-Gemini audio: 16 kHz PCM input and 24 kHz output.
- OAuth code + PKCE through Cognito, with the access token kept in a scoped HttpOnly cookie.
- Strict, retry-safe evidence batches for transcript, code, canvas, scenarios, usage, and completion.
- Atomic global/per-user monthly quotas and idempotent session creation.
- SQS independent grader with an evidence schema and DynamoDB grading lease; its stored Gemini report is not yet read by the browser.
- CloudWatch JSON logs, EMF metrics, dashboard, baseline alarms, X-Ray, and production Lambda canaries.
- Nonce CSP, security headers, exact-origin checks, bounded JSON, safe errors, and log redaction.

## Architecture

~~~mermaid
flowchart LR
  Browser[Candidate browser] --> BFF[Next.js BFF on Vercel]
  BFF <-->|OAuth code + PKCE| Cognito[AWS Cognito]
  BFF -->|HttpOnly access token| API[API Gateway]
  API --> Session[Session Lambda]
  API --> Events[Event Lambda]
  Session --> DDB[(DynamoDB)]
  Session --> Secret[Secrets Manager]
  Session --> Token[Gemini token service]
  Token --> Browser
  Browser <-->|direct audio WebSocket| Live[Gemini Live]
  Events --> DDB
  Events --> Queue[SQS + DLQ]
  Queue --> Grader[Grader Lambda]
  Grader --> Grade[Gemini text grader]
  Grader --> DDB
  API --> CW[CloudWatch + X-Ray]
~~~

Audio does not traverse API Gateway or Lambda.

## Run P0 locally

Requirements: Node.js 22 and pnpm 11.19.

~~~bash
pnpm install
pnpm dev
~~~

Open http://localhost:3000. With no .env.local, the app uses mock mode and never requests microphone access or calls Gemini.

Optional local Gemini mode:

~~~dotenv
GEMINI_API_KEY=your_server_only_key
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
~~~

Never rename the key to a NEXT_PUBLIC_ variable. Do not expose this unauthenticated local-key route on a public deployment.

## Test everything

~~~bash
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

Jest and CDK assertions use no cloud credentials. The current suite contains 58 application tests, 23 infrastructure tests, and one Playwright candidate journey. Playwright stubs only the session-provisioning response, so it exercises the production UI without a model call or weakening the production fail-closed policy.

## Deploy the P1 application plane

### 1. Bootstrap AWS once

Authenticate an AWS CLI profile for the target account, then bootstrap Singapore:

~~~bash
pnpm exec cdk bootstrap aws://ACCOUNT_ID/ap-southeast-1
~~~

The stack is intentionally pinned to ap-southeast-1.

### 2. Choose the final web origin

Cognito callback URLs and API CORS use one exact origin. For production, choose the Vercel custom domain before deploying AWS, for example https://interviews.example.com.

### 3. Test, synthesize, and deploy

PowerShell example for a local development origin:

~~~powershell
$env:DEPLOY_STAGE = "dev"
$env:P1_ALLOWED_ORIGIN = "http://localhost:3000"
pnpm infra:test
pnpm infra:synth --context stage=dev
pnpm infra:deploy --context stage=dev
~~~

The stack outputs ApiUrl, UserPoolId, UserPoolClientId, CognitoDomain, GeminiSecretArn, ArtifactsBucketName, and DashboardName.

By default CDK creates a Secrets Manager secret containing a random placeholder. Replace that value in the AWS console with the Gemini key before starting a real interview. To reuse an existing secret, set GEMINI_SECRET_ARN before synthesis/deployment. Never paste a production key into source, CloudFormation parameters, GitHub variables, or shell history.

### 4. Configure the web BFF

Map stack outputs into server-only web environment variables:

~~~dotenv
P1_API_URL=https://the-api-id.execute-api.ap-southeast-1.amazonaws.com
APP_ORIGIN=https://your-final-web-origin.example
COGNITO_CLIENT_ID=the-UserPoolClientId-output
COGNITO_DOMAIN=https://the-CognitoDomain-output
~~~

Do not configure GEMINI_API_KEY on the P1 Vercel project. When P1_API_URL is unset, development and test deliberately fall back to the local P0 path. Production fails closed with a 503 response instead of exposing an unauthenticated mock or Gemini route.

For a local BFF against a deployed development stack, use APP_ORIGIN=http://localhost:3000 and ensure the stack was deployed with that same allowed origin.

## GitHub CI/CD

CI has separate app-quality, infrastructure, and browser jobs. It performs a frozen lockfile install, fails on moderate-or-higher vulnerabilities across production and build dependencies, and enforces a one-day package release-age gate with exact reviewed exceptions recorded for the pinned Vercel CLI dependency set. CodeQL, dependency review, and Dependabot run alongside it. Third-party actions are pinned to immutable commit SHAs.

### AWS environments

Create GitHub environments named development, staging, and production. Configure:

- P1_AWS_DEPLOY_ENABLED=true as a repository variable only after the development environment is fully configured; leaving it unset keeps automatic AWS deploys dormant.
- AWS_DEPLOY_ROLE_ARN: environment variable for the least-privilege GitHub OIDC role.
- AWS_REGION=ap-southeast-1.
- P1_ALLOWED_ORIGIN: exact web origin for that environment.
- GEMINI_SECRET_ARN: optional existing secret ARN.
- GLOBAL_MONTHLY_INTERVIEW_LIMIT=10.
- USER_MONTHLY_INTERVIEW_LIMIT=10 or lower.
- SESSION_DURATION_MINUTES=10 or lower.
- P1_HEALTHCHECK_URL and P1_SMOKE_PATH: optional smoke-test overrides.

deploy-p1-aws.yml automatically deploys development only when the repository variable P1_AWS_DEPLOY_ENABLED is exactly true and CI succeeds on a trusted main push. Manual runs remain available while the flag is unset, but fail closed until their selected environment is configured. Every manual stage requires successful CI for the selected revision; production requires push-triggered CI on that exact main revision. Staging and production are manual and environment-gated. No long-lived AWS access key is stored in GitHub.

After the first run of the new workflows, protect main against force-push/deletion and require the CI quality, infrastructure, browser, CodeQL, and dependency-review checks appropriate to the event. Add at least one required reviewer to the production environment and restrict it to main before configuring deployment credentials.

### Vercel production

Configure the production GitHub environment:

- VERCEL_ORG_ID and VERCEL_PROJECT_ID as variables.
- VERCEL_TOKEN as a narrowly scoped secret.

Configure P1_API_URL, APP_ORIGIN, COGNITO_CLIENT_ID, and COGNITO_DOMAIN in the Vercel production project. Run deploy-vercel.yml manually from main only after the matching AWS production deployment is healthy. The workflow verifies exact-revision CI, keeps the token scoped to CLI steps, deploys a candidate, checks health/P1 auth configuration, and promotes only the verified artifact.

Disable Vercel Git auto-deployments if this workflow is authoritative. AWS Amplify remains a manual compatibility-gated fallback because its documented managed support currently stops at Next.js 15 while this project uses Next.js 16.

## Current cost ceiling

For ten 10-minute interviews per month:

| Area | Monthly planning range |
|---|---:|
| Gemini Live, including context-rebilling headroom | $3–$6 |
| Independent Gemini grading | < $0.25 |
| AWS serverless application plane | about $2.50–$7 |
| Eligible Vercel Hobby hosting | $0 |
| **Expected total** | **about $5.75–$13.25** |

The audio-only Gemini lower bound is about $0.73 for all ten interviews. The API key itself has no fee. CloudWatch alarms/custom metrics and Secrets Manager dominate the tiny AWS workload. Avoid WAF, Managed Grafana, Managed Prometheus, NAT Gateway, Aurora, and always-on containers for this $25/month pilot.

The UI stops at ten wall-clock minutes, but the direct-to-Gemini credential remains valid for a two-minute reconnect margin. Since AWS is intentionally off the audio path, the provider-side hard upper bound is 12 minutes rather than exactly 10; budget alerts remain necessary.

Pricing is a 2026-09-01 planning snapshot. Measured provider usage and actual bills are the source of truth; see [architecture.md](./architecture.md) for formulas and the future 1,000 × 45-minute scenario.

## Privacy and launch limits

- Audio is never uploaded by the current app.
- P1 stores transcript/code/canvas evidence and reports in DynamoDB.
- The S3 recordings/ lifecycle deletes current and noncurrent object versions after 30 days, but no consent/upload UI exists.
- A user-facing export/delete workflow is still required before public production.
- Operational logs reject interview content and credentials.
- Public P1 also requires budget alerts, authenticated/provider E2E tests, reconnect recovery, coordinated rollback, abuse review, and load testing.

## Next steps

1. Deploy a development stack, replace the placeholder secret, and run an authenticated synthetic session/event test.
2. Add an authenticated report-read endpoint and poll it so the stored Gemini grading report replaces the immediate local scorecard.
3. Finish GoAway/network/device recovery and persist Gemini resumption handles.
4. Add user export/deletion and explicit retention/recording consent.
5. Add authenticated Playwright tests and a 25-concurrent-session load test.
6. Emit measured Gemini usage/cost, reconnect, provider-error, and abandonment metrics with budget alarms.
7. Add an authenticated release smoke and coordinated AWS-to-Vercel production promotion/rollback.
8. Add rewind/retry, longitudinal skill history, Excalidraw, and isolated browser workers for code execution.
