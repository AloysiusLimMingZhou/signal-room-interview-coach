# Signal Room v2 Phase 1: Lean Platform and First Deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trim the AWS stack to always-free limits, add owner/guest access tiers with per-channel quotas, expose a read-only account API (role/allowances, history, stored report), and deploy `dev` + `prod` for real.

**Architecture:** Vercel-hosted Next.js BFF → API Gateway HTTP API (Cognito JWT) → Lambdas → DynamoDB single table. A pure `infra/lib/access-policy.ts` module owns roles and allowances for both CDK and Lambdas. Shared HTTP contracts for the new account API live in `src/lib/p1/account.ts`. Monitoring exists only in `prod`.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, Zod 4, AWS CDK 2, Lambda Node.js 22 (ARM), DynamoDB, SQS, Cognito, SSM Parameter Store, CloudWatch, AWS Budgets, SNS, Jest 30, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-15-signal-room-v2-design.md` (§4 is this plan's scope). Phase 2 (§5) gets its own plan after the Task 16 deployment checkpoint answers verification items V1–V4.

## Global Constraints

- AWS region is pinned to `ap-southeast-1`. Node.js 22, pnpm 11.19.0.
- Hard caps: voice global ≤ **10**/UTC month, voice session ≤ **10** minutes, text global ≤ **60**/UTC month. Defaults: voice owner 10, voice guest 2, text owner 60, text guest 5.
- Never expose the Gemini standard key to browser code, logs, fixtures, screenshots, or commits. No automated test may call real Gemini or AWS.
- Source files stay within ~400–500 lines; split by responsibility beyond that.
- Validate every external input with Zod or an explicit allowlist at trust boundaries. Audit each change against the OWASP Top 10 (Task 15 has the checklist).
- **No Claude attribution:** commits and PRs carry no `Co-Authored-By` trailer and no "Generated with Claude Code" line. Commits use the repo identity `AloysiusLimMingZhou <aloysiuslim1003@gmail.com>`.
- Before writing any Next.js route code, read the relevant guide in `node_modules/next/dist/docs/` (per `AGENTS.md`).
- `architecture.md` stays the source of truth; Task 14 updates it before the integration PR merges to `main`.

## Deviations from the spec (decided while planning)

| Spec | Plan | Why |
|---|---|---|
| §4.4: `src/lib/p1/quota.ts` becomes channel-aware | Roles, limits, and quota keys live in `infra/lib/access-policy.ts` | `infra/tsconfig.json` has `rootDir: "."`, so CDK code cannot import `src/`. Lambdas (bundled by esbuild) can import `infra/lib`. |
| Env var for the key parameter | `GEMINI_KEY_PARAMETER_NAME` | A name containing `GEMINI_API_KEY` would trip the existing "no key in Lambda config" assertion. |
| Budget email only | `ALERT_EMAIL` feeds both the AWS Budget and an SNS topic that the 8 prod alarms notify | Alarms without actions are invisible; SNS email is free at this volume. |
| Not in spec | Replace `dynamodb:TransactWriteItems` grants with the underlying `PutItem`/`UpdateItem`/`DeleteItem` actions | DynamoDB authorizes transactions via the underlying item actions ([AWS docs](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)). The current stack would fail on its first real write. |
| §4.5 grader sets `failed` | The grader writes terminal failure in Phase 1 (retry endpoint stays in Phase 2) | §4.5's history status needs it. |

## Execution lanes (CLAUDE.md rule 4)

All lane branches start from and merge back into the integration branch `feature/v2-phase1`. Lane PRs stay small and merge often. The integration branch merges to `main` once, with `architecture.md` updated.

| Order | Lane (worktree) | Tasks | PR into `feature/v2-phase1` | Depends on |
|---|---|---|---|---|
| 1 | Contracts (`v2-contracts`) | 1, 2 | PR-1 "shared contracts" | — |
| 2a | Backend (`v2-backend`) | 3, 4, 5 | PR-2 "lambda runtime helpers" | PR-1 |
| 2b | Infra config (`v2-infra`) | 10, 12 | PR-3 "config and workflows" | PR-1 |
| 2c | Frontend/BFF (`v2-frontend`) | 13 | PR-4 "account BFF routes" | PR-1 |
| 3 | Backend (`v2-backend`) | 6, 7, 8, 9 | PR-5 "handlers" | PR-2 |
| 4 | Infra stack (`v2-infra`) | 11 | PR-6 "lean stack" | PR-3, PR-5 (CDK bundles `account-handler.ts`) |
| 5 | Testing & docs (`v2-docs`) | 14, 15 | PR-7 "docs and verification", then integration PR to `main` | all |
| 6 | Owner (manual) | 16 | — | integration PR merged |

Each subagent gets exactly one task at a time, with this plan and the spec. The coordinating session reviews each task before the next is dispatched.

## File map

| File | Status | Responsibility |
|---|---|---|
| `infra/lib/access-policy.ts` | Create | Roles, allowance limits, hard caps, env-var names, quota keys (pure) |
| `src/lib/p1/report.ts` | Create | Grading report v1 schema + `overallScore` (moved from infra) |
| `src/lib/p1/account.ts` | Create | Zod contracts for `/v1/me`, `/v1/sessions`, report read |
| `src/lib/p1/index.ts` | Modify | Re-export `account` and `report` |
| `infra/lambda/shared/contracts.ts` | Modify | Re-export report schemas from `src/lib/p1/report` |
| `infra/lambda/shared/http.ts` | Modify | `authenticatedRole`, route/path/query event fields |
| `infra/lambda/shared/allowances.ts` | Create | Read allowances + voice duration from Lambda env |
| `infra/lambda/shared/table-keys.ts` | Create | DynamoDB key builders shared by handlers |
| `src/lib/p1/metrics.ts`, `infra/lambda/shared/logging.ts` | Modify | New metric names; EMF only in prod; `account.read` log operation |
| `infra/lambda/shared/aws-clients.ts`, `infra/lambda/shared/gemini.ts` | Modify | SSM client; key from SSM with 5-minute cache |
| `infra/lambda/session-store.ts` | Create | Session persistence extracted from the handler (quota, history, rollback) |
| `infra/lambda/session-handler.ts` | Modify | Role gate, voice reservation, history key |
| `infra/lambda/event-handler.ts` | Modify | History → `grading` on completion |
| `infra/lambda/grading-handler.ts` | Modify | History outcome; terminal failure |
| `infra/lambda/account-handler.ts` | Create | `GET /v1/me`, `GET /v1/sessions`, `GET /v1/sessions/{sessionId}/report` |
| `infra/lib/p1-config.ts`, `infra/bin/p1.ts` | Modify | New config shape |
| `infra/lib/p1-stack.ts` | Modify | Lean stack |
| `infra/lib/observability.ts` | Create | Prod-only alarms, dashboard, SNS topic, budget |
| `.github/workflows/deploy-p1-aws.yml` | Modify | Two stages, new variables |
| `.github/workflows/deploy-amplify.yml`, `amplify.yml` | Delete | Unused |
| `scripts/invite-user.sh`, `scripts/invite-user.ps1` | Create | Invite a user into a group |
| `src/lib/server/p1-api.ts` | Modify | GET support + path allowlist |
| `src/lib/server/p1-read.ts` | Create | Shared BFF read proxy |
| `src/app/api/me/route.ts`, `src/app/api/sessions/route.ts`, `src/app/api/sessions/[id]/report/route.ts` | Create | BFF read routes |
| `src/app/api/realtime/session/route.ts`, `src/components/interview-app.tsx` | Modify | 403 `account_not_enabled` handling; "Request access" link |
| `src/lib/server/contact-url.ts`, `src/app/api/auth/session/route.ts` | Create / Modify | Validated `CONTACT_URL` exposed to the sign-in screen |
| `architecture.md`, `README.md` | Modify | Documentation |

---

### Task 0: Integration branch and lane worktrees

**Files:** none (git only).

- [ ] **Step 1: Merge the spec branch to `main`.** From the main checkout (`C:\Users\aloys\signal-room-interview-coach`), open a PR from `claude/interview-platform-brainstorm-a7721a` (spec + `.gitignore`). Ask the owner before merging.

```bash
gh pr create --base main --head claude/interview-platform-brainstorm-a7721a --title "docs: Signal Room v2 design spec and Phase 1 plan" --body "Adds the approved v2 design spec, the Phase 1 implementation plan, and ignores local Claude Code files."
```

- [ ] **Step 2: Create the integration branch from updated `main`.**

```bash
git switch main && git pull --ff-only && git switch -c feature/v2-phase1 && git push -u origin feature/v2-phase1
```

- [ ] **Step 3: Create each lane worktree when its lane starts** (under `.claude/worktrees/`, so the root `CLAUDE.md` applies). Example for the contracts lane:

```bash
git worktree add .claude/worktrees/v2-contracts -b feature/v2-phase1-contracts feature/v2-phase1
cd .claude/worktrees/v2-contracts && pnpm install --frozen-lockfile
```

Expected: install succeeds; `pnpm test:ci` and `pnpm infra:test` pass on the untouched branch.

---

### Task 1: Access policy module

**Files:**
- Create: `infra/lib/access-policy.ts`
- Test: `infra/test/access-policy.test.ts`

**Interfaces:**
- Produces:
  - `type AccessRole = "owner" | "guest" | "none"`; `type QuotaChannel = "voice" | "text"`; `type QuotaScope = "global" | "owner" | "guest"`
  - `type ChannelLimits = Record<QuotaScope, number>`; `type AllowanceLimits = Record<QuotaChannel, ChannelLimits>`; `type ItemKey = { PK: string; SK: string }`
  - `HARD_LIMITS: { voiceGlobalMonthly: 10; voiceSessionMinutes: 10; textGlobalMonthly: 60 }`
  - `DEFAULT_ALLOWANCE_LIMITS: AllowanceLimits`
  - `ALLOWANCE_ENVIRONMENT_NAMES: Record<QuotaChannel, Record<QuotaScope, string>>`
  - `validateAllowanceLimits(limits: AllowanceLimits): AllowanceLimits`
  - `readAllowanceLimits(read: (name: string, fallback: number) => number): AllowanceLimits`
  - `allowanceEnvironment(limits: AllowanceLimits): Record<string, string>`
  - `userAllowance(role: AccessRole, channel: QuotaChannel, limits: AllowanceLimits): number`
  - `parseRoleFromGroupsClaim(claim: unknown): AccessRole`
  - `quotaKeys(channel: QuotaChannel, userId: string, monthKey: string): { global: ItemKey; user: ItemKey }`

- [ ] **Step 1: Write the failing test** — `infra/test/access-policy.test.ts`

```ts
/** @jest-environment node */
import {
  allowanceEnvironment,
  DEFAULT_ALLOWANCE_LIMITS,
  parseRoleFromGroupsClaim,
  quotaKeys,
  readAllowanceLimits,
  userAllowance,
  validateAllowanceLimits,
  type AllowanceLimits,
} from "../lib/access-policy";

function limits(overrides: Partial<Record<"voice" | "text", Partial<AllowanceLimits["voice"]>>> = {}): AllowanceLimits {
  return {
    voice: { ...DEFAULT_ALLOWANCE_LIMITS.voice, ...overrides.voice },
    text: { ...DEFAULT_ALLOWANCE_LIMITS.text, ...overrides.text },
  };
}

describe("allowance limits", () => {
  it("accepts the documented defaults", () => {
    expect(validateAllowanceLimits(limits())).toEqual({
      voice: { global: 10, owner: 10, guest: 2 },
      text: { global: 60, owner: 60, guest: 5 },
    });
  });

  it("enforces the hard caps", () => {
    expect(() => validateAllowanceLimits(limits({ voice: { global: 11 } }))).toThrow(/hard cap of 10/);
    expect(() => validateAllowanceLimits(limits({ text: { global: 61 } }))).toThrow(/hard cap of 60/);
  });

  it("keeps per-role limits within the channel's global limit", () => {
    expect(() => validateAllowanceLimits(limits({ voice: { global: 5, owner: 6 } }))).toThrow(/global limit/);
    expect(() => validateAllowanceLimits(limits({ text: { guest: 61 } }))).toThrow(/hard cap|global limit/);
  });

  it("rejects zero, negative, and fractional limits", () => {
    expect(() => validateAllowanceLimits(limits({ voice: { guest: 0 } }))).toThrow(/positive integer/);
    expect(() => validateAllowanceLimits(limits({ text: { owner: 1.5 } }))).toThrow(/positive integer/);
  });

  it("reads each limit by its environment name with defaults", () => {
    const read = jest.fn((name: string, fallback: number) => (name === "VOICE_GUEST_MONTHLY_LIMIT" ? 1 : fallback));
    expect(readAllowanceLimits(read).voice.guest).toBe(1);
    expect(read).toHaveBeenCalledTimes(6);
  });

  it("serializes limits into Lambda environment variables", () => {
    expect(allowanceEnvironment(limits())).toEqual({
      VOICE_GLOBAL_MONTHLY_LIMIT: "10",
      VOICE_OWNER_MONTHLY_LIMIT: "10",
      VOICE_GUEST_MONTHLY_LIMIT: "2",
      TEXT_GLOBAL_MONTHLY_LIMIT: "60",
      TEXT_OWNER_MONTHLY_LIMIT: "60",
      TEXT_GUEST_MONTHLY_LIMIT: "5",
    });
  });

  it("gives role none no allowance", () => {
    expect(userAllowance("none", "voice", limits())).toBe(0);
    expect(userAllowance("guest", "voice", limits())).toBe(2);
    expect(userAllowance("owner", "text", limits())).toBe(60);
  });
});

describe("role resolution from the cognito:groups claim", () => {
  it.each([
    ["[owner]", "owner"],
    ["[guest owner]", "owner"],
    ["[guest]", "guest"],
    ["owner,guest", "owner"],
    ['["guest"]', "guest"],
    [["owner"], "owner"],
  ])("resolves %p to %s", (claim, role) => {
    expect(parseRoleFromGroupsClaim(claim)).toBe(role);
  });

  it.each([undefined, null, 42, "", "[admin]", "[Owner]", "x".repeat(1_025), '["owner"'])(
    "fails closed for %p",
    (claim) => {
      expect(parseRoleFromGroupsClaim(claim)).toBe("none");
    },
  );
});

describe("quota keys", () => {
  it("separates channels and users by UTC month", () => {
    expect(quotaKeys("voice", "user-1", "2026-09")).toEqual({
      global: { PK: "QUOTA#GLOBAL#VOICE", SK: "MONTH#2026-09" },
      user: { PK: "QUOTA#USER#user-1#VOICE", SK: "MONTH#2026-09" },
    });
    expect(quotaKeys("text", "user-1", "2026-09").user.PK).toBe("QUOTA#USER#user-1#TEXT");
  });

  it("rejects malformed month keys", () => {
    expect(() => quotaKeys("voice", "user-1", "MONTH#2026-09")).toThrow(/YYYY-MM/);
  });
});
```

The claim is signed by Cognito, so the parser only needs to be tolerant of formatting, not adversarial input. Malformed JSON (`'["owner"'`) still fails closed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm infra:test -- access-policy`
Expected: FAIL — `Cannot find module '../lib/access-policy'`.

- [ ] **Step 3: Implement** — `infra/lib/access-policy.ts`

```ts
/**
 * Access tiers and monthly allowances. Pure and dependency-free so the CDK stack
 * (compiled with rootDir=infra) and the bundled Lambdas share one policy.
 */
export type AccessRole = "owner" | "guest" | "none";
export type QuotaChannel = "voice" | "text";
export type QuotaScope = "global" | "owner" | "guest";
export type ChannelLimits = Record<QuotaScope, number>;
export type AllowanceLimits = Record<QuotaChannel, ChannelLimits>;
// A type alias (not an interface) so it is assignable to DynamoDB key records.
export type ItemKey = { PK: string; SK: string };

export const HARD_LIMITS = Object.freeze({
  voiceGlobalMonthly: 10,
  voiceSessionMinutes: 10,
  textGlobalMonthly: 60,
});

export const DEFAULT_ALLOWANCE_LIMITS: AllowanceLimits = Object.freeze({
  voice: Object.freeze({ global: 10, owner: 10, guest: 2 }),
  text: Object.freeze({ global: 60, owner: 60, guest: 5 }),
});

export const ALLOWANCE_ENVIRONMENT_NAMES: Record<QuotaChannel, Record<QuotaScope, string>> = {
  voice: {
    global: "VOICE_GLOBAL_MONTHLY_LIMIT",
    owner: "VOICE_OWNER_MONTHLY_LIMIT",
    guest: "VOICE_GUEST_MONTHLY_LIMIT",
  },
  text: {
    global: "TEXT_GLOBAL_MONTHLY_LIMIT",
    owner: "TEXT_OWNER_MONTHLY_LIMIT",
    guest: "TEXT_GUEST_MONTHLY_LIMIT",
  },
};

const CHANNELS: readonly QuotaChannel[] = ["voice", "text"];
const SCOPES: readonly QuotaScope[] = ["global", "owner", "guest"];
const HARD_GLOBAL_LIMIT: Record<QuotaChannel, number> = {
  voice: HARD_LIMITS.voiceGlobalMonthly,
  text: HARD_LIMITS.textGlobalMonthly,
};
const MAX_GROUPS_CLAIM_LENGTH = 1_024;
const GROUP_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export function validateAllowanceLimits(limits: AllowanceLimits): AllowanceLimits {
  for (const channel of CHANNELS) {
    for (const scope of SCOPES) {
      const value = limits[channel][scope];
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${ALLOWANCE_ENVIRONMENT_NAMES[channel][scope]} must be a positive integer.`);
      }
    }
    const { global, owner, guest } = limits[channel];
    if (global > HARD_GLOBAL_LIMIT[channel]) {
      throw new Error(
        `${ALLOWANCE_ENVIRONMENT_NAMES[channel].global} cannot exceed the hard cap of ${HARD_GLOBAL_LIMIT[channel]}.`,
      );
    }
    if (owner > global || guest > global) {
      throw new Error(`Per-role ${channel} limits cannot exceed the ${channel} global limit.`);
    }
  }
  return limits;
}

export function readAllowanceLimits(read: (name: string, fallback: number) => number): AllowanceLimits {
  const channelLimits = (channel: QuotaChannel): ChannelLimits => ({
    global: read(ALLOWANCE_ENVIRONMENT_NAMES[channel].global, DEFAULT_ALLOWANCE_LIMITS[channel].global),
    owner: read(ALLOWANCE_ENVIRONMENT_NAMES[channel].owner, DEFAULT_ALLOWANCE_LIMITS[channel].owner),
    guest: read(ALLOWANCE_ENVIRONMENT_NAMES[channel].guest, DEFAULT_ALLOWANCE_LIMITS[channel].guest),
  });
  return validateAllowanceLimits({ voice: channelLimits("voice"), text: channelLimits("text") });
}

export function allowanceEnvironment(limits: AllowanceLimits): Record<string, string> {
  const validated = validateAllowanceLimits(limits);
  return Object.fromEntries(
    CHANNELS.flatMap((channel) =>
      SCOPES.map((scope) => [ALLOWANCE_ENVIRONMENT_NAMES[channel][scope], String(validated[channel][scope])]),
    ),
  );
}

export function userAllowance(role: AccessRole, channel: QuotaChannel, limits: AllowanceLimits): number {
  return role === "none" ? 0 : limits[channel][role];
}

function stringsOnly(values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string");
}

function groupTokens(claim: unknown): string[] {
  if (Array.isArray(claim)) return stringsOnly(claim);
  if (typeof claim !== "string" || claim.length > MAX_GROUPS_CLAIM_LENGTH) return [];
  const trimmed = claim.trim();
  if (trimmed.startsWith("[") && trimmed.includes('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? stringsOnly(parsed) : [];
    } catch {
      return [];
    }
  }
  return trimmed.replace(/^\[/, "").replace(/\]$/, "").split(/[\s,]+/);
}

/**
 * Resolves the caller's tier from the Cognito `cognito:groups` claim. The HTTP API
 * JWT authorizer flattens array claims to strings such as "[owner guest]", so both
 * shapes are accepted. Unknown or malformed values fail closed to "none".
 */
export function parseRoleFromGroupsClaim(claim: unknown): AccessRole {
  const groups = new Set(groupTokens(claim).filter((token) => GROUP_NAME.test(token)));
  if (groups.has("owner")) return "owner";
  if (groups.has("guest")) return "guest";
  return "none";
}

/** `monthKey` is `getUtcMonthWindow(now).key`, for example "2026-09". */
export function quotaKeys(
  channel: QuotaChannel,
  userId: string,
  monthKey: string,
): { global: ItemKey; user: ItemKey } {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error("monthKey must be YYYY-MM.");
  const suffix = channel.toUpperCase();
  const SK = `MONTH#${monthKey}`;
  return {
    global: { PK: `QUOTA#GLOBAL#${suffix}`, SK },
    user: { PK: `QUOTA#USER#${userId}#${suffix}`, SK },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm infra:test -- access-policy`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add infra/lib/access-policy.ts infra/test/access-policy.test.ts
git commit -m "feat(access): add owner/guest roles and per-channel allowance policy"
```

---

### Task 2: Shared account API contracts

**Files:**
- Create: `src/lib/p1/report.ts`, `src/lib/p1/account.ts`
- Modify: `src/lib/p1/index.ts`, `infra/lambda/shared/contracts.ts:26-45`
- Test: `src/lib/p1/account.test.ts`

**Interfaces:**
- Produces (from `src/lib/p1/report.ts`): `evidenceReferenceSchema`, `evidenceScoreSchema`, `gradingReportSchema`, `type GradingReport`, `overallScore(report: GradingReport): number` (mean, one decimal).
- Produces (from `src/lib/p1/account.ts`): `accessRoleSchema`, `quotaChannelSchema`, `allowanceSchema`, `meResponseSchema`, `historyStatusSchema` (`"active" | "grading" | "graded" | "failed"`), `sessionSummarySchema`, `SESSION_LIST_MAX_LIMIT = 50`, `sessionListResponseSchema`, `reportStatusSchema` (`"pending" | "grading" | "complete" | "failed"`), `reportV1Schema`, `reportResponseSchema`, and the inferred types `MeResponse`, `SessionSummary`, `SessionListResponse`, `ReportResponse`.

- [ ] **Step 1: Write the failing test** — `src/lib/p1/account.test.ts`

```ts
import {
  meResponseSchema,
  reportResponseSchema,
  sessionListResponseSchema,
  sessionSummarySchema,
} from "./account";
import { overallScore, type GradingReport } from "./report";

const allowance = { used: 1, limit: 10, globalRemaining: 7, resetsAt: "2026-10-01T00:00:00.000Z" };
const eventId = "0e8f2a4c-6b1d-4c3e-9f5a-1b2c3d4e5f60";

function report(scores: number[]): GradingReport {
  return {
    summary: "Clear approach with a missing complexity analysis.",
    scores: scores.map((score, index) => ({
      competency: `competency-${index}`,
      score,
      confidence: 0.8,
      evidenceReferences: [{ eventId, rationale: "Stated the approach." }],
      feedback: "Quantify the bottleneck.",
      retryPrompt: "Explain the complexity again.",
    })),
  };
}

describe("account contracts", () => {
  it("accepts a well-formed /v1/me response and rejects unknown keys", () => {
    const valid = { role: "guest", quotas: { voice: allowance, text: { ...allowance, limit: 5 } } };
    expect(meResponseSchema.parse(valid)).toEqual(valid);
    expect(() => meResponseSchema.parse({ ...valid, isAdmin: true })).toThrow();
    expect(() => meResponseSchema.parse({ ...valid, role: "admin" })).toThrow();
  });

  it("bounds session summaries and list pages", () => {
    const summary = {
      sessionId: "6a27e013-3d62-4828-a38d-177c0212399e",
      createdAt: "2026-09-15T10:00:00.000Z",
      channel: "voice",
      track: "algorithms",
      level: "mid",
      questionTitle: "Algorithms",
      status: "graded",
      overallScore: 3.5,
    };
    expect(sessionSummarySchema.parse(summary)).toEqual(summary);
    expect(() => sessionSummarySchema.parse({ ...summary, overallScore: 6 })).toThrow();
    expect(() => sessionSummarySchema.parse({ ...summary, PK: "USER#x" })).toThrow();
    expect(() => sessionListResponseSchema.parse({ items: [], nextCursor: "not a cursor!" })).toThrow();
  });

  it("requires schemaVersion on stored v1 reports", () => {
    const complete = { status: "complete", report: { ...report([4]), schemaVersion: 1 }, gradedAt: "2026-09-15T10:05:00.000Z" };
    expect(reportResponseSchema.parse(complete).status).toBe("complete");
    expect(() => reportResponseSchema.parse({ status: "complete", report: report([4]) })).toThrow();
    expect(reportResponseSchema.parse({ status: "pending" })).toEqual({ status: "pending" });
  });

  it("computes the overall score as a one-decimal mean", () => {
    expect(overallScore(report([4, 3, 5]))).toBe(4);
    expect(overallScore(report([4, 3]))).toBe(3.5);
    expect(overallScore(report([3, 3, 4]))).toBe(3.3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/lib/p1/account.test.ts`
Expected: FAIL — `Cannot find module './account'`.

- [ ] **Step 3: Create `src/lib/p1/report.ts`** (the schemas move here verbatim from `infra/lambda/shared/contracts.ts:26-45`)

```ts
import { z } from "zod";

export const evidenceReferenceSchema = z.object({
  eventId: z.string().uuid(),
  rationale: z.string().trim().min(1).max(1_000),
}).strict();

export const evidenceScoreSchema = z.object({
  competency: z.string().trim().min(1).max(120),
  score: z.number().min(0).max(5),
  confidence: z.number().min(0).max(1),
  evidenceReferences: z.array(evidenceReferenceSchema).min(1).max(20),
  feedback: z.string().trim().min(1).max(4_000),
  retryPrompt: z.string().trim().min(1).max(2_000),
}).strict();

export const gradingReportSchema = z.object({
  summary: z.string().trim().min(1).max(4_000),
  scores: z.array(evidenceScoreSchema).min(1).max(20),
}).strict();

export type GradingReport = z.infer<typeof gradingReportSchema>;

/** Mean competency score rounded to one decimal; reports always have ≥ 1 score. */
export function overallScore(report: GradingReport): number {
  const total = report.scores.reduce((sum, score) => sum + score.score, 0);
  return Math.round((total / report.scores.length) * 10) / 10;
}
```

- [ ] **Step 4: Create `src/lib/p1/account.ts`**

```ts
import { z } from "zod";
import { gradingReportSchema } from "./report";

const count = z.number().int().nonnegative().max(1_000);
const isoTimestamp = z.string().datetime({ offset: true });

export const accessRoleSchema = z.enum(["owner", "guest", "none"]);
export const quotaChannelSchema = z.enum(["voice", "text"]);

export const allowanceSchema = z.object({
  used: count,
  limit: count,
  globalRemaining: count,
  resetsAt: isoTimestamp,
}).strict();

export const meResponseSchema = z.object({
  role: accessRoleSchema,
  quotas: z.object({ voice: allowanceSchema, text: allowanceSchema }).strict(),
}).strict();

export const historyStatusSchema = z.enum(["active", "grading", "graded", "failed"]);

export const sessionSummarySchema = z.object({
  sessionId: z.string().uuid(),
  createdAt: isoTimestamp,
  channel: quotaChannelSchema,
  track: z.string().min(1).max(40),
  level: z.string().min(1).max(40),
  questionTitle: z.string().min(1).max(120),
  status: historyStatusSchema,
  overallScore: z.number().min(0).max(5).optional(),
}).strict();

export const SESSION_LIST_MAX_LIMIT = 50;

export const sessionListResponseSchema = z.object({
  items: z.array(sessionSummarySchema).max(SESSION_LIST_MAX_LIMIT),
  nextCursor: z.string().min(1).max(1_024).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();

export const reportStatusSchema = z.enum(["pending", "grading", "complete", "failed"]);
export const reportV1Schema = gradingReportSchema.extend({ schemaVersion: z.literal(1) }).strict();

export const reportResponseSchema = z.object({
  status: reportStatusSchema,
  report: reportV1Schema.optional(),
  gradedAt: isoTimestamp.optional(),
}).strict();

export type MeResponse = z.infer<typeof meResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type ReportResponse = z.infer<typeof reportResponseSchema>;
```

- [ ] **Step 5: Re-export from `src/lib/p1/index.ts`** — append two lines:

```ts
export * from "./account";
export * from "./report";
```

- [ ] **Step 6: Point the infra contracts at the moved schemas.** In `infra/lambda/shared/contracts.ts`, delete lines 26–45 (`evidenceReferenceSchema` through `export type GradingReport`) and add after the existing `export type { ... }` line:

```ts
export {
  evidenceScoreSchema,
  gradingReportSchema,
  type GradingReport,
} from "../../../src/lib/p1/report";
```

Keep `import { z } from "zod";` — `gradingMessageSchema` still uses it.

- [ ] **Step 7: Run the tests**

Run: `pnpm test -- src/lib/p1 && pnpm infra:test && pnpm typecheck`
Expected: PASS; no type errors (the grader still imports `gradingReportSchema` from `./shared/contracts`).

- [ ] **Step 8: Commit and open PR-1**

```bash
git add src/lib/p1/report.ts src/lib/p1/account.ts src/lib/p1/account.test.ts src/lib/p1/index.ts infra/lambda/shared/contracts.ts
git commit -m "feat(contracts): add account API contracts and shared report schema"
git push -u origin feature/v2-phase1-contracts
gh pr create --base feature/v2-phase1 --title "Phase 1: shared contracts" --body "Access policy (roles, allowances, quota keys) and Zod contracts for the account API. Tasks 1-2 of docs/superpowers/plans/2026-09-16-signal-room-v2-phase1.md."
```

---

### Task 3: Lambda runtime helpers (role, allowances, table keys)

**Files:**
- Modify: `infra/lambda/shared/http.ts`
- Create: `infra/lambda/shared/allowances.ts`, `infra/lambda/shared/table-keys.ts`
- Test: `infra/test/lambda-runtime.test.ts`

**Interfaces:**
- Consumes: `parseRoleFromGroupsClaim`, `readAllowanceLimits`, `HARD_LIMITS`, `ItemKey`, `AllowanceLimits`, `AccessRole` (Task 1).
- Produces:
  - `authenticatedRole(event: ApiGatewayV2Event): AccessRole`
  - `ApiGatewayV2Event` gains optional `routeKey?: string`, `pathParameters?: Record<string, string | undefined>`, `queryStringParameters?: Record<string, string | undefined>`
  - `allowanceLimitsFromEnvironment(): AllowanceLimits`; `voiceSessionMinutesFromEnvironment(): number`
  - `REPORT_SORT_KEY = "REPORT#P1#v1"`, `HISTORY_SORT_PREFIX = "SESSION#"`, `sessionMetaKey(sessionId): ItemKey`, `reportKey(sessionId): ItemKey`, `historySortKey(createdAt, sessionId): string`, `historyKey(userId, historySk): ItemKey`

- [ ] **Step 1: Write the failing test** — `infra/test/lambda-runtime.test.ts`

```ts
/** @jest-environment node */
import {
  allowanceLimitsFromEnvironment,
  voiceSessionMinutesFromEnvironment,
} from "../lambda/shared/allowances";
import { authenticatedRole, type ApiGatewayV2Event } from "../lambda/shared/http";
import { historyKey, historySortKey, reportKey, sessionMetaKey } from "../lambda/shared/table-keys";

const ENV_NAMES = ["VOICE_GLOBAL_MONTHLY_LIMIT", "VOICE_GUEST_MONTHLY_LIMIT", "VOICE_SESSION_MINUTES"] as const;
const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function eventWithGroups(groups?: unknown): ApiGatewayV2Event {
  return {
    requestContext: {
      requestId: "request-1",
      authorizer: {
        jwt: { claims: { sub: "user-1", ...(groups === undefined ? {} : { "cognito:groups": groups }) } },
      },
    },
  };
}

describe("authenticated role", () => {
  it("reads the flattened cognito:groups claim", () => {
    expect(authenticatedRole(eventWithGroups("[guest]"))).toBe("guest");
    expect(authenticatedRole(eventWithGroups("[guest owner]"))).toBe("owner");
  });

  it("treats a missing claim as none", () => {
    expect(authenticatedRole(eventWithGroups())).toBe("none");
  });
});

describe("allowances from the Lambda environment", () => {
  it("uses defaults and honors overrides", () => {
    delete process.env.VOICE_GLOBAL_MONTHLY_LIMIT;
    process.env.VOICE_GUEST_MONTHLY_LIMIT = "1";
    expect(allowanceLimitsFromEnvironment().voice).toEqual({ global: 10, owner: 10, guest: 1 });
  });

  it("fails closed when configuration exceeds the hard caps", () => {
    process.env.VOICE_GLOBAL_MONTHLY_LIMIT = "11";
    expect(() => allowanceLimitsFromEnvironment()).toThrow(/hard cap/);
    process.env.VOICE_SESSION_MINUTES = "11";
    expect(() => voiceSessionMinutesFromEnvironment()).toThrow(/hard cap/);
  });
});

describe("table keys", () => {
  it("builds the documented single-table keys", () => {
    expect(sessionMetaKey("s1")).toEqual({ PK: "SESSION#s1", SK: "META" });
    expect(reportKey("s1")).toEqual({ PK: "SESSION#s1", SK: "REPORT#P1#v1" });
    expect(historySortKey("2026-09-15T10:00:00.000Z", "s1")).toBe("SESSION#2026-09-15T10:00:00.000Z#s1");
    expect(historyKey("u1", "SESSION#x")).toEqual({ PK: "USER#u1", SK: "SESSION#x" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm infra:test -- lambda-runtime`
Expected: FAIL — `Cannot find module '../lambda/shared/allowances'`.

- [ ] **Step 3: Extend `infra/lambda/shared/http.ts`.** Add the import at the top:

```ts
import { parseRoleFromGroupsClaim, type AccessRole } from "../../lib/access-policy";
```

Add three optional fields to `ApiGatewayV2Event`, directly after `isBase64Encoded?: boolean;`:

```ts
  routeKey?: string;
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
```

Add after `authenticatedUserId`:

```ts
/** Access tier from the Cognito-signed access token; fails closed to "none". */
export function authenticatedRole(event: ApiGatewayV2Event): AccessRole {
  return parseRoleFromGroupsClaim(event.requestContext.authorizer?.jwt?.claims?.["cognito:groups"]);
}
```

- [ ] **Step 4: Create `infra/lambda/shared/allowances.ts`**

```ts
import { HARD_LIMITS, readAllowanceLimits, type AllowanceLimits } from "../../lib/access-policy";
import { positiveIntegerEnvironment } from "./aws-clients";

export function allowanceLimitsFromEnvironment(): AllowanceLimits {
  return readAllowanceLimits(positiveIntegerEnvironment);
}

export function voiceSessionMinutesFromEnvironment(): number {
  const minutes = positiveIntegerEnvironment("VOICE_SESSION_MINUTES", HARD_LIMITS.voiceSessionMinutes);
  if (minutes > HARD_LIMITS.voiceSessionMinutes) {
    throw new Error("VOICE_SESSION_MINUTES exceeds the hard cap.");
  }
  return minutes;
}
```

- [ ] **Step 5: Create `infra/lambda/shared/table-keys.ts`**

```ts
import type { ItemKey } from "../../lib/access-policy";

export const REPORT_SORT_KEY = "REPORT#P1#v1";
export const HISTORY_SORT_PREFIX = "SESSION#";

export function sessionMetaKey(sessionId: string): ItemKey {
  return { PK: `SESSION#${sessionId}`, SK: "META" };
}

export function reportKey(sessionId: string): ItemKey {
  return { PK: `SESSION#${sessionId}`, SK: REPORT_SORT_KEY };
}

/** Sorts a user's sessions by creation time; the session ID keeps keys unique. */
export function historySortKey(createdAt: string, sessionId: string): string {
  return `${HISTORY_SORT_PREFIX}${createdAt}#${sessionId}`;
}

export function historyKey(userId: string, historySk: string): ItemKey {
  return { PK: `USER#${userId}`, SK: historySk };
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm infra:test -- lambda-runtime && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add infra/lambda/shared/http.ts infra/lambda/shared/allowances.ts infra/lambda/shared/table-keys.ts infra/test/lambda-runtime.test.ts
git commit -m "feat(lambda): resolve access role, allowances, and shared table keys"
```

---

### Task 4: Production-only custom metrics and new log operation

**Files:**
- Modify: `src/lib/p1/metrics.ts:3-14`, `infra/lambda/shared/logging.ts:12,88-93`
- Test: `infra/test/metrics-emission.test.ts`

**Interfaces:**
- Produces: metric names `session_setup_failed` and `grading_failed` (unit `Count`); `emitMetric` becomes a no-op unless `ENVIRONMENT` is `prod`/`production`; log operation `account.read`.

- [ ] **Step 1: Write the failing test** — `infra/test/metrics-emission.test.ts`

```ts
/** @jest-environment node */
import { emitMetric, validateSafeLogMetadata } from "../lambda/shared/logging";

const originalEnvironment = process.env.ENVIRONMENT;

afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = originalEnvironment;
  jest.restoreAllMocks();
});

describe("custom metric emission", () => {
  it("emits nothing outside production so dev stays inside the free tier", () => {
    process.env.ENVIRONMENT = "dev";
    const write = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    emitMetric("session_setup_failed", 1, "Count");
    expect(write).not.toHaveBeenCalled();
  });

  it("writes an EMF document in production", () => {
    process.env.ENVIRONMENT = "prod";
    const write = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    emitMetric("grading_failed", 1, "Count");
    const document = JSON.parse(String(write.mock.calls[0][0]));
    expect(document._aws.CloudWatchMetrics[0].Metrics).toEqual([{ Name: "grading_failed", Unit: "Count" }]);
    expect(document).toMatchObject({ Environment: "production", Provider: "application", grading_failed: 1 });
  });
});

describe("safe log operations", () => {
  it("accepts the account read operation", () => {
    expect(validateSafeLogMetadata({ level: "INFO", operation: "account.read", result: "success" }).operation)
      .toBe("account.read");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm infra:test -- metrics-emission`
Expected: FAIL — unknown metric `grading_failed`, dev write called, and unknown operation `account.read`.

- [ ] **Step 3: Add the metric names.** In `src/lib/p1/metrics.ts`, add two entries to `metricNameSchema` after `"idempotency_conflict",`:

```ts
  "session_setup_failed",
  "grading_failed",
```

- [ ] **Step 4: Gate EMF to production and add the operation.** In `infra/lambda/shared/logging.ts`:

Replace line 12 with:

```ts
  operation: z.enum(["session.create", "event.append", "grading.run", "account.read"]),
```

Make this the first statement inside `emitMetric`:

```ts
  // CloudWatch's free tier allows 10 custom metrics per account; only prod emits them.
  if (environment() !== "production") return;
```

- [ ] **Step 5: Run all tests**

Run: `pnpm infra:test && pnpm test -- src/lib/p1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/p1/metrics.ts infra/lambda/shared/logging.ts infra/test/metrics-emission.test.ts
git commit -m "feat(observability): emit custom metrics only in prod and add failure metrics"
```

---

### Task 5: Load the Gemini key from SSM Parameter Store

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (via pnpm), `infra/lambda/shared/aws-clients.ts`, `infra/lambda/shared/gemini.ts:1-60`
- Test: `infra/test/gemini-key.test.ts`

**Interfaces:**
- Produces: `ssmClient` (replaces `secretsClient`); `loadGeminiApiKey(now?: number): Promise<string>` reading env `GEMINI_KEY_PARAMETER_NAME`, cached for 5 minutes; `clearGeminiApiKeyCache(): void`.

- [ ] **Step 1: Swap the SDK dependency**

```bash
pnpm remove @aws-sdk/client-secrets-manager
pnpm add @aws-sdk/client-ssm
```

Expected: the lockfile updates; the one-day `minimumReleaseAge` gate selects a version at least a day old. Nothing else imports `client-secrets-manager` (checked: only `aws-clients.ts` and `gemini.ts`).

- [ ] **Step 2: Write the failing test** — `infra/test/gemini-key.test.ts`

```ts
/** @jest-environment node */
jest.mock("../lambda/shared/aws-clients", () => {
  const actual = jest.requireActual("../lambda/shared/aws-clients");
  return { ...actual, ssmClient: { send: jest.fn() } };
});

import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { ssmClient } from "../lambda/shared/aws-clients";
import { clearGeminiApiKeyCache, loadGeminiApiKey } from "../lambda/shared/gemini";

const mockSend = ssmClient.send as jest.Mock;
const apiKey = "k".repeat(39);

describe("Gemini API key loading", () => {
  beforeEach(() => {
    process.env.GEMINI_KEY_PARAMETER_NAME = "/signal-room/test/gemini-api-key";
    mockSend.mockReset();
    clearGeminiApiKeyCache();
  });

  it("reads the SecureString parameter with decryption", async () => {
    mockSend.mockResolvedValue({ Parameter: { Value: apiKey } });
    await expect(loadGeminiApiKey(0)).resolves.toBe(apiKey);
    const command = mockSend.mock.calls[0][0] as GetParameterCommand;
    expect(command).toBeInstanceOf(GetParameterCommand);
    expect(command.input).toEqual({ Name: "/signal-room/test/gemini-api-key", WithDecryption: true });
  });

  it("caches the key for five minutes per container", async () => {
    mockSend.mockResolvedValue({ Parameter: { Value: apiKey } });
    await loadGeminiApiKey(0);
    await loadGeminiApiKey(299_999);
    expect(mockSend).toHaveBeenCalledTimes(1);
    await loadGeminiApiKey(300_000);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("accepts the JSON value shape", async () => {
    mockSend.mockResolvedValue({ Parameter: { Value: JSON.stringify({ GEMINI_API_KEY: apiKey }) } });
    await expect(loadGeminiApiKey(0)).resolves.toBe(apiKey);
  });

  it("rejects a placeholder without caching it", async () => {
    mockSend
      .mockResolvedValueOnce({ Parameter: { Value: "short" } })
      .mockResolvedValueOnce({ Parameter: { Value: apiKey } });
    await expect(loadGeminiApiKey(0)).rejects.toThrow(/not configured/);
    await expect(loadGeminiApiKey(1)).resolves.toBe(apiKey);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm infra:test -- gemini-key`
Expected: FAIL — `ssmClient` / `clearGeminiApiKeyCache` do not exist.

- [ ] **Step 4: Replace the client in `infra/lambda/shared/aws-clients.ts`.** Swap line 2 for `import { SSMClient } from "@aws-sdk/client-ssm";` and line 10 for:

```ts
export const ssmClient = new SSMClient({});
```

- [ ] **Step 5: Replace key loading in `infra/lambda/shared/gemini.ts`.** Replace lines 1–3 with:

```ts
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { gradingReportSchema, type GradingReport, type SessionRequest } from "./contracts";
import { requiredEnvironment, ssmClient } from "./aws-clients";
```

In `parseSecretValue` (lines 32–51), change the three messages to say "Gemini API key" instead of "Gemini secret". Keep the logic. Replace `loadGeminiApiKey` (lines 53–60) with:

```ts
const KEY_CACHE_TTL_MS = 5 * 60_000;
let cachedKey: { value: string; loadedAt: number } | undefined;

export function clearGeminiApiKeyCache(): void {
  cachedKey = undefined;
}

/** Reads the SecureString once per container per five minutes so key rotation takes effect. */
export async function loadGeminiApiKey(now = Date.now()): Promise<string> {
  if (cachedKey && now - cachedKey.loadedAt < KEY_CACHE_TTL_MS) return cachedKey.value;
  const response = await ssmClient.send(new GetParameterCommand({
    Name: requiredEnvironment("GEMINI_KEY_PARAMETER_NAME"),
    WithDecryption: true,
  }));
  const value = response.Parameter?.Value;
  if (typeof value !== "string") throw new Error("Gemini API key parameter has no value.");
  const key = parseSecretValue(value);
  cachedKey = { value: key, loadedAt: now };
  return key;
}
```

The placeholder message ("... is not configured.") must still contain "not configured" for the test.

- [ ] **Step 6: Update the session test's environment.** In `infra/test/session-handler.test.ts:47`, replace the `GEMINI_SECRET_ARN` line with:

```ts
    process.env.GEMINI_KEY_PARAMETER_NAME = "/signal-room/test/gemini-api-key";
```

- [ ] **Step 7: Run the tests**

Run: `pnpm infra:test && pnpm typecheck && pnpm audit:deps`
Expected: all PASS. `p1-stack.test.ts` still passes because the stack is unchanged until Task 11.

- [ ] **Step 8: Commit and open PR-2**

```bash
git add package.json pnpm-lock.yaml infra/lambda/shared/aws-clients.ts infra/lambda/shared/gemini.ts infra/test/gemini-key.test.ts infra/test/session-handler.test.ts
git commit -m "feat(secrets): load the Gemini key from SSM Parameter Store with a 5-minute cache"
git push -u origin feature/v2-phase1-backend
gh pr create --base feature/v2-phase1 --title "Phase 1: Lambda runtime helpers" --body "Role resolution, allowances, table keys, prod-only custom metrics, and SSM-backed Gemini key loading. Tasks 3-5."
```

---

### Task 6: Session store extraction, role gate, voice quota, history item

`session-handler.ts` is 537 lines. Persistence moves to `session-store.ts`, leaving the handler at about 250 lines.

**Files:**
- Create: `infra/lambda/session-store.ts`
- Modify: `infra/lambda/session-handler.ts` (full replacement below)
- Test: `infra/test/session-handler.test.ts` (full replacement below)

**Interfaces:**
- Consumes: `quotaKeys`, `userAllowance`, `ItemKey`, `AccessRole` (Task 1); `authenticatedRole`, `allowanceLimitsFromEnvironment`, `voiceSessionMinutesFromEnvironment`, `sessionMetaKey`, `historyKey`, `historySortKey` (Task 3); `emitMetric("session_setup_failed")` (Task 4).
- Produces (DynamoDB items later tasks read):
  - Session `META` gains `role`, `channel: "voice"`, `historySk`.
  - History item `PK=USER#<sub>`, `SK=<historySk>`, attributes `entityType: "SessionHistory"`, `sessionId`, `createdAt`, `channel`, `track`, `level`, `questionTitle`, `status: "active"`.
  - Quota counters at `quotaKeys("voice", sub, month)`.
  - Error `403 account_not_enabled` for role `none`.

- [ ] **Step 1: Write the failing tests** — replace `infra/test/session-handler.test.ts` with:

```ts
/** @jest-environment node */

jest.mock("../lambda/shared/aws-clients", () => {
  const actual = jest.requireActual("../lambda/shared/aws-clients");
  return { ...actual, documentClient: { send: jest.fn() } };
});

jest.mock("../lambda/shared/gemini", () => ({
  loadGeminiApiKey: jest.fn(),
  provisionGeminiToken: jest.fn(),
  resolvedGeminiLiveModel: () => "gemini-3.1-flash-live-preview",
}));

import { createHash } from "node:crypto";
import { documentClient } from "../lambda/shared/aws-clients";
import { loadGeminiApiKey, provisionGeminiToken } from "../lambda/shared/gemini";
import { handler } from "../lambda/session-handler";
import type { ApiGatewayV2Event } from "../lambda/shared/http";

const mockDocumentSend = documentClient.send as jest.Mock;
const mockLoadGeminiApiKey = loadGeminiApiKey as jest.Mock;
const mockProvisionGeminiToken = provisionGeminiToken as jest.Mock;

const userId = "user-1234";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const requestBody = {
  track: "system-design",
  difficulty: "senior",
  providerPreference: "gemini",
  durationMinutes: 10,
};
const canonicalHash = createHash("sha256").update(JSON.stringify(requestBody)).digest("hex");

function apiEvent(groups: string | undefined = "[owner]"): ApiGatewayV2Event {
  return {
    body: JSON.stringify(requestBody),
    headers: { "content-type": "application/json", "idempotency-key": "request-1234" },
    requestContext: {
      requestId: "api-request-1234",
      authorizer: { jwt: { claims: { sub: userId, ...(groups ? { "cognito:groups": groups } : {}) } } },
    },
  };
}

function provisionSucceeds() {
  mockLoadGeminiApiKey.mockResolvedValue("standard-key-stays-server-side");
  mockProvisionGeminiToken.mockResolvedValue({
    token: "authTokens/new-one-use-token",
    model: "gemini-3.1-flash-live-preview",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

describe("session creation", () => {
  beforeEach(() => {
    process.env.TABLE_NAME = "sessions";
    process.env.GEMINI_KEY_PARAMETER_NAME = "/signal-room/test/gemini-api-key";
    mockDocumentSend.mockReset();
    mockLoadGeminiApiKey.mockReset();
    mockProvisionGeminiToken.mockReset();
  });

  it("replays the same stored ephemeral credential without provisioning another token", async () => {
    const now = new Date();
    mockDocumentSend
      .mockResolvedValueOnce({ Item: { createdAt: now.toISOString(), requestHash: canonicalHash, sessionId } })
      .mockResolvedValueOnce({
        Item: {
          requestHash: canonicalHash,
          sessionId,
          token: "authTokens/same-one-use-token",
          model: "gemini-3.1-flash-live-preview",
          tokenExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
          durationMinutes: 10,
        },
      });

    const response = await handler(apiEvent());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ sessionId, token: "authTokens/same-one-use-token" });
    expect(mockProvisionGeminiToken).not.toHaveBeenCalled();
  });

  it("does not mint a token while another identical request is still provisioning", async () => {
    mockDocumentSend
      .mockResolvedValueOnce({ Item: { createdAt: new Date().toISOString(), requestHash: canonicalHash, sessionId } })
      .mockResolvedValueOnce({});

    const response = await handler(apiEvent());

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ error: "session_request_pending" });
    expect(mockProvisionGeminiToken).not.toHaveBeenCalled();
  });

  it("rejects an account outside the owner and guest groups before touching quota", async () => {
    const response = await handler(apiEvent(undefined));

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: "account_not_enabled" });
    expect(mockDocumentSend).not.toHaveBeenCalled();
  });

  it("reserves voice quota and writes the history item in the session transaction", async () => {
    mockDocumentSend.mockResolvedValue({});
    provisionSucceeds();

    const response = await handler(apiEvent("[owner]"));

    expect(response.statusCode).toBe(201);
    expect(mockProvisionGeminiToken).toHaveBeenCalledTimes(1);
    expect(mockDocumentSend).toHaveBeenCalledTimes(5);
    const items = mockDocumentSend.mock.calls[3][0].input.TransactItems;
    expect(items[0].Update.Key.PK).toBe("QUOTA#GLOBAL#VOICE");
    expect(items[1].Update.Key.PK).toBe(`QUOTA#USER#${userId}#VOICE`);
    expect(items[1].Update.ExpressionAttributeValues[":limit"]).toBe(10);
    const meta = items[3].Put.Item;
    const history = items[4].Put.Item;
    expect(meta).toMatchObject({ role: "owner", channel: "voice" });
    expect(history).toMatchObject({
      PK: `USER#${userId}`,
      SK: meta.historySk,
      entityType: "SessionHistory",
      channel: "voice",
      track: "system-design",
      level: "senior",
      questionTitle: "System design",
      status: "active",
    });
    expect(history.SK).toMatch(/^SESSION#\d{4}-\d{2}-\d{2}T.*#[0-9a-f-]{36}$/);
  });

  it("applies the guest voice allowance", async () => {
    mockDocumentSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { used: 0 } })
      .mockResolvedValueOnce({ Item: { used: 2 } });

    const response = await handler(apiEvent("[guest]"));

    expect(response.statusCode).toBe(429);
    expect(mockProvisionGeminiToken).not.toHaveBeenCalled();
  });

  it("releases the reservation and history item when provisioning fails", async () => {
    mockDocumentSend.mockResolvedValue({});
    mockLoadGeminiApiKey.mockResolvedValue("standard-key-stays-server-side");
    mockProvisionGeminiToken.mockRejectedValue(new Error("Gemini ephemeral-token provisioning failed."));

    const response = await handler(apiEvent("[owner]"));

    expect(response.statusCode).toBe(503);
    const rollback = mockDocumentSend.mock.calls[4][0].input.TransactItems;
    expect(rollback).toHaveLength(5);
    expect(rollback[4].Delete.Key.PK).toBe(`USER#${userId}`);
    expect(rollback[4].Delete.Key.SK).toMatch(/^SESSION#/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm infra:test -- session-handler`
Expected: FAIL — the new tests fail (no 403; quota key `QUOTA#GLOBAL`; no history item).

- [ ] **Step 3: Create `infra/lambda/session-store.ts`**

```ts
import { GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { AccessRole, ItemKey } from "../lib/access-policy";
import { documentClient } from "./shared/aws-clients";
import type { SessionRequest } from "./shared/contracts";
import type { ProvisionedToken } from "./shared/gemini";
import { SafeHttpError, secondsUntilNextUtcMonth } from "./shared/http";
import { historyKey, sessionMetaKey } from "./shared/table-keys";

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

export interface IdempotencyRecord {
  createdAt?: unknown;
  requestHash?: unknown;
  sessionId?: unknown;
}

export interface SessionResponseRecord {
  requestHash?: unknown;
  sessionId?: unknown;
  token?: unknown;
  model?: unknown;
  tokenExpiresAt?: unknown;
  durationMinutes?: unknown;
}

export interface QuotaReservation {
  keys: { global: ItemKey; user: ItemKey };
  globalLimit: number;
  userLimit: number;
}

// Phase 1 sessions have no question bank yet, so history shows the track label.
const LEGACY_TRACK_TITLES: Record<SessionRequest["track"], string> = {
  "system-design": "System design",
  "ml-design": "ML system design",
  algorithms: "Algorithms",
};

const MUST_NOT_EXIST = "attribute_not_exists(PK) AND attribute_not_exists(SK)";

function quotaExpiry(now: Date): number {
  return Math.floor(Date.UTC(now.getUTCFullYear() + 2, now.getUTCMonth() + 1, 1) / 1_000);
}

function idempotencyKeys(userId: string, key: string): ItemKey {
  return { PK: `USER#${userId}`, SK: `SESSION_REQUEST#${key}` };
}

function responseKeys(userId: string, key: string): ItemKey {
  return { PK: `USER#${userId}`, SK: `SESSION_RESPONSE#${key}` };
}

export async function getIdempotencyRecord(
  tableName: string,
  userId: string,
  key: string,
): Promise<IdempotencyRecord | undefined> {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: idempotencyKeys(userId, key),
    ConsistentRead: true,
    ProjectionExpression: "createdAt, requestHash, sessionId",
  }));
  return response.Item as IdempotencyRecord | undefined;
}

export async function getSessionResponse(
  tableName: string,
  userId: string,
  key: string,
): Promise<SessionResponseRecord | undefined> {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: responseKeys(userId, key),
    ConsistentRead: true,
    ProjectionExpression: "requestHash, sessionId, #token, model, tokenExpiresAt, durationMinutes",
    ExpressionAttributeNames: { "#token": "token" },
  }));
  return response.Item as SessionResponseRecord | undefined;
}

async function quotaUsed(tableName: string, key: ItemKey): Promise<number> {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: key,
    ConsistentRead: true,
    ProjectionExpression: "used",
  }));
  const used = (response.Item as { used?: unknown } | undefined)?.used;
  return typeof used === "number" && Number.isSafeInteger(used) ? used : 0;
}

/** A cheap pre-check; the transaction's conditions remain the real guarantee. */
export async function assertQuotaLikelyAvailable(
  tableName: string,
  reservation: QuotaReservation,
  now: Date,
): Promise<void> {
  const [globalUsed, userUsed] = await Promise.all([
    quotaUsed(tableName, reservation.keys.global),
    quotaUsed(tableName, reservation.keys.user),
  ]);
  if (globalUsed >= reservation.globalLimit || userUsed >= reservation.userLimit) {
    throw new SafeHttpError(
      429,
      "monthly_quota_exhausted",
      "The monthly voice interview allowance has been reached.",
      { "Retry-After": String(secondsUntilNextUtcMonth(now)) },
    );
  }
}

function quotaIncrement(tableName: string, key: ItemKey, limit: number, now: string, expiresAt: number): TransactItem {
  return {
    Update: {
      TableName: tableName,
      Key: key,
      UpdateExpression: "SET #used = if_not_exists(#used, :zero) + :one, #limit = :limit, updatedAt = :now, expiresAt = :expiresAt",
      ConditionExpression: "attribute_not_exists(#used) OR #used < :limit",
      ExpressionAttributeNames: { "#used": "used", "#limit": "limit" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": limit, ":now": now, ":expiresAt": expiresAt },
    },
  };
}

function quotaDecrement(tableName: string, key: ItemKey): TransactItem {
  return {
    Update: {
      TableName: tableName,
      Key: key,
      UpdateExpression: "SET #used = #used - :one",
      ConditionExpression: "#used >= :one",
      ExpressionAttributeNames: { "#used": "used" },
      ExpressionAttributeValues: { ":one": 1 },
    },
  };
}

export async function persistSession(input: {
  tableName: string;
  sessionId: string;
  userId: string;
  role: Exclude<AccessRole, "none">;
  key: string;
  hash: string;
  request: SessionRequest;
  now: Date;
  durationMinutes: number;
  model: string;
  reservation: QuotaReservation;
  historySk: string;
}): Promise<void> {
  const expiresAt = quotaExpiry(input.now);
  const createdAt = input.now.toISOString();
  const sessionEndsAt = new Date(input.now.getTime() + input.durationMinutes * 60_000).toISOString();

  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      quotaIncrement(input.tableName, input.reservation.keys.global, input.reservation.globalLimit, createdAt, expiresAt),
      quotaIncrement(input.tableName, input.reservation.keys.user, input.reservation.userLimit, createdAt, expiresAt),
      {
        Put: {
          TableName: input.tableName,
          Item: {
            ...idempotencyKeys(input.userId, input.key),
            entityType: "SessionRequest",
            requestHash: input.hash,
            sessionId: input.sessionId,
            createdAt,
            expiresAt,
          },
          ConditionExpression: MUST_NOT_EXIST,
        },
      },
      {
        Put: {
          TableName: input.tableName,
          Item: {
            ...sessionMetaKey(input.sessionId),
            entityType: "InterviewSession",
            sessionId: input.sessionId,
            userId: input.userId,
            role: input.role,
            channel: "voice",
            track: input.request.track,
            difficulty: input.request.difficulty,
            provider: "gemini",
            model: input.model,
            durationMinutes: input.durationMinutes,
            status: "provisioning",
            lastSequence: 0,
            eventCount: 0,
            createdAt,
            sessionEndsAt,
            historySk: input.historySk,
          },
          ConditionExpression: MUST_NOT_EXIST,
        },
      },
      {
        Put: {
          TableName: input.tableName,
          Item: {
            ...historyKey(input.userId, input.historySk),
            entityType: "SessionHistory",
            sessionId: input.sessionId,
            createdAt,
            channel: "voice",
            track: input.request.track,
            level: input.request.difficulty,
            questionTitle: LEGACY_TRACK_TITLES[input.request.track],
            status: "active",
          },
          ConditionExpression: MUST_NOT_EXIST,
        },
      },
    ],
  }));
}

export async function persistProvisionedResponse(input: {
  tableName: string;
  sessionId: string;
  userId: string;
  key: string;
  hash: string;
  token: ProvisionedToken;
  durationMinutes: number;
  now: Date;
}): Promise<void> {
  const tokenExpiresAtEpoch = Math.floor(Date.parse(input.token.expiresAt) / 1_000) + 60;
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: input.tableName,
          Key: sessionMetaKey(input.sessionId),
          UpdateExpression: "SET #status = :ready, credentialExpiresAt = :tokenExpiresAt",
          ConditionExpression: "userId = :userId AND #status = :provisioning",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":userId": input.userId,
            ":provisioning": "provisioning",
            ":ready": "created",
            ":tokenExpiresAt": input.token.expiresAt,
          },
        },
      },
      {
        Put: {
          TableName: input.tableName,
          Item: {
            ...responseKeys(input.userId, input.key),
            entityType: "SessionResponse",
            requestHash: input.hash,
            sessionId: input.sessionId,
            token: input.token.token,
            model: input.token.model,
            tokenExpiresAt: input.token.expiresAt,
            durationMinutes: input.durationMinutes,
            createdAt: input.now.toISOString(),
            expiresAt: tokenExpiresAtEpoch,
          },
          ConditionExpression: MUST_NOT_EXIST,
        },
      },
    ],
  }));
}

export async function rollbackSessionReservation(input: {
  tableName: string;
  sessionId: string;
  userId: string;
  key: string;
  reservation: QuotaReservation;
  historySk: string;
}): Promise<void> {
  const ownedBySession = {
    ConditionExpression: "sessionId = :sessionId",
    ExpressionAttributeValues: { ":sessionId": input.sessionId },
  };
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      quotaDecrement(input.tableName, input.reservation.keys.global),
      quotaDecrement(input.tableName, input.reservation.keys.user),
      { Delete: { TableName: input.tableName, Key: idempotencyKeys(input.userId, input.key), ...ownedBySession } },
      {
        Delete: {
          TableName: input.tableName,
          Key: sessionMetaKey(input.sessionId),
          ConditionExpression: "userId = :userId AND #status = :provisioning",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":userId": input.userId, ":provisioning": "provisioning" },
        },
      },
      { Delete: { TableName: input.tableName, Key: historyKey(input.userId, input.historySk), ...ownedBySession } },
    ],
  }));
}
```

- [ ] **Step 4: Replace `infra/lambda/session-handler.ts`** with:

```ts
import { createHash, randomUUID } from "node:crypto";
import { getUtcMonthWindow } from "../../src/lib/p1/quota";
import { quotaKeys, userAllowance } from "../lib/access-policy";
import {
  assertQuotaLikelyAvailable,
  getIdempotencyRecord,
  getSessionResponse,
  persistProvisionedResponse,
  persistSession,
  rollbackSessionReservation,
  type QuotaReservation,
  type SessionResponseRecord,
} from "./session-store";
import { allowanceLimitsFromEnvironment, voiceSessionMinutesFromEnvironment } from "./shared/allowances";
import { requiredEnvironment } from "./shared/aws-clients";
import {
  sessionCreationResponseSchema,
  sessionRequestSchema,
  type SessionRequest,
} from "./shared/contracts";
import {
  loadGeminiApiKey,
  provisionGeminiToken,
  resolvedGeminiLiveModel,
  type ProvisionedToken,
} from "./shared/gemini";
import {
  authenticatedRole,
  authenticatedUserId,
  errorResponse,
  idempotencyKey,
  jsonResponse,
  parseJsonRequest,
  SafeHttpError,
  type ApiGatewayV2Event,
  type ApiResponse,
} from "./shared/http";
import { baseLogMetadata, emitMetric, hashReference, writeSafeLog } from "./shared/logging";
import { historySortKey } from "./shared/table-keys";

const OPERATION = "session.create" as const;
const REQUEST_REPLAY_WINDOW_MS = 2 * 60_000;

function requestHash(request: SessionRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function descriptor(sessionId: string, token: ProvisionedToken, durationMinutes: number) {
  return sessionCreationResponseSchema.parse({
    sessionId,
    mode: "gemini" as const,
    provider: "gemini" as const,
    model: token.model,
    token: token.token,
    expiresAt: token.expiresAt,
    maxDurationMinutes: durationMinutes,
    persistence: "aws" as const,
    resume: {
      enabled: true,
      contextCompressionTriggerTokens: 25_000,
      slidingWindowTokens: 8_000,
    },
  });
}

function descriptorFromStoredResponse(
  response: SessionResponseRecord | undefined,
  expectedHash: string,
  expectedSessionId: string,
  now: Date,
) {
  if (
    response?.requestHash !== expectedHash ||
    response.sessionId !== expectedSessionId ||
    typeof response.token !== "string" ||
    typeof response.model !== "string" ||
    typeof response.tokenExpiresAt !== "string" ||
    typeof response.durationMinutes !== "number" ||
    Date.parse(response.tokenExpiresAt) <= now.getTime()
  ) return undefined;

  return descriptor(
    expectedSessionId,
    { token: response.token, model: response.model, expiresAt: response.tokenExpiresAt },
    response.durationMinutes,
  );
}

function pendingRequestError(): SafeHttpError {
  return new SafeHttpError(
    409,
    "session_request_pending",
    "The original session request is still completing.",
    { "Retry-After": "1" },
  );
}

function resultForError(error: unknown) {
  if (error instanceof SafeHttpError) {
    if (error.errorCode === "monthly_quota_exhausted") return "quota_exhausted" as const;
    if (error.statusCode === 401 || error.statusCode === 403) return "unauthorized" as const;
    return "invalid_request" as const;
  }
  return "internal_error" as const;
}

export async function handler(event: ApiGatewayV2Event): Promise<ApiResponse> {
  const startedAt = Date.now();
  let sessionRef: string | undefined;
  try {
    const tableName = requiredEnvironment("TABLE_NAME");
    const userId = authenticatedUserId(event);
    const role = authenticatedRole(event);
    if (role === "none") {
      throw new SafeHttpError(403, "account_not_enabled", "This account has not been enabled. Access is invite-only.");
    }
    const parsed = sessionRequestSchema.safeParse(parseJsonRequest(event, 8 * 1_024));
    if (!parsed.success) {
      throw new SafeHttpError(400, "invalid_request", "Choose a supported track and difficulty.");
    }

    const key = idempotencyKey(event);
    const hash = requestHash(parsed.data);
    if (parsed.data.durationMinutes > voiceSessionMinutesFromEnvironment()) {
      throw new SafeHttpError(400, "duration_limit", "The requested interview duration exceeds the pilot limit.");
    }
    const durationMinutes = parsed.data.durationMinutes;
    const limits = allowanceLimitsFromEnvironment();
    const now = new Date();
    const reservation: QuotaReservation = {
      keys: quotaKeys("voice", userId, getUtcMonthWindow(now).key),
      globalLimit: limits.voice.global,
      userLimit: userAllowance(role, "voice", limits),
    };
    const existing = await getIdempotencyRecord(tableName, userId, key);

    if (existing) {
      if (existing.requestHash !== hash || typeof existing.sessionId !== "string") {
        emitMetric("idempotency_conflict", 1, "Count");
        throw new SafeHttpError(409, "idempotency_conflict", "That idempotency key was already used for a different request.");
      }
      const createdAt = typeof existing.createdAt === "string" ? Date.parse(existing.createdAt) : Number.NaN;
      if (!Number.isFinite(createdAt) || now.getTime() - createdAt > REQUEST_REPLAY_WINDOW_MS) {
        throw new SafeHttpError(409, "session_request_expired", "Start a new interview session request.");
      }
      sessionRef = hashReference(existing.sessionId);
      const storedDescriptor = descriptorFromStoredResponse(
        await getSessionResponse(tableName, userId, key),
        hash,
        existing.sessionId,
        now,
      );
      if (!storedDescriptor) throw pendingRequestError();
      writeSafeLog({
        ...baseLogMetadata(),
        level: "INFO",
        operation: OPERATION,
        result: "idempotent_replay",
        requestId: event.requestContext.requestId,
        sessionRef,
        provider: "gemini",
        model: storedDescriptor.model,
        durationMs: Date.now() - startedAt,
      });
      return jsonResponse(200, storedDescriptor);
    }

    await assertQuotaLikelyAvailable(tableName, reservation, now);
    const sessionId = randomUUID();
    sessionRef = hashReference(sessionId);
    const model = resolvedGeminiLiveModel();
    const historySk = historySortKey(now.toISOString(), sessionId);

    try {
      await persistSession({
        tableName,
        sessionId,
        userId,
        role,
        key,
        hash,
        request: parsed.data,
        now,
        durationMinutes,
        model,
        reservation,
        historySk,
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;

      const racedRecord = await getIdempotencyRecord(tableName, userId, key);
      if (racedRecord?.requestHash === hash && typeof racedRecord.sessionId === "string") {
        sessionRef = hashReference(racedRecord.sessionId);
        const racedDescriptor = descriptorFromStoredResponse(
          await getSessionResponse(tableName, userId, key),
          hash,
          racedRecord.sessionId,
          now,
        );
        if (racedDescriptor) return jsonResponse(200, racedDescriptor);
        throw pendingRequestError();
      }
      await assertQuotaLikelyAvailable(tableName, reservation, now);
      emitMetric("idempotency_conflict", 1, "Count");
      throw new SafeHttpError(409, "idempotency_conflict", "The request conflicted with another session start.");
    }

    let token: ProvisionedToken;
    try {
      const apiKey = await loadGeminiApiKey();
      token = await provisionGeminiToken(apiKey, parsed.data, now, durationMinutes + 2);
      await persistProvisionedResponse({ tableName, sessionId, userId, key, hash, token, durationMinutes, now });
    } catch (error) {
      try {
        await rollbackSessionReservation({ tableName, sessionId, userId, key, reservation, historySk });
      } catch {
        // A failed compensation leaves the conservative quota reservation in place.
      }
      throw error;
    }

    const durationMs = Date.now() - startedAt;
    emitMetric("session_setup_ms", durationMs, "Milliseconds");
    writeSafeLog({
      ...baseLogMetadata(),
      level: "INFO",
      operation: OPERATION,
      result: "success",
      requestId: event.requestContext.requestId,
      sessionRef,
      provider: "gemini",
      model: token.model,
      durationMs,
    });
    return jsonResponse(201, descriptor(sessionId, token, durationMinutes));
  } catch (error) {
    const isProviderError = error instanceof Error && error.message.startsWith("Gemini");
    const safeError = isProviderError
      ? new SafeHttpError(503, "provider_unavailable", "Gemini Live could not be provisioned. Retry shortly.")
      : error;
    const isServerFailure = !(safeError instanceof SafeHttpError) || safeError.statusCode >= 500;
    if (isServerFailure) emitMetric("session_setup_failed", 1, "Count");
    writeSafeLog({
      ...baseLogMetadata(),
      level: isServerFailure ? "ERROR" : "WARN",
      operation: OPERATION,
      result: isProviderError ? "provider_unavailable" : resultForError(safeError),
      requestId: event.requestContext.requestId,
      sessionRef,
      durationMs: Date.now() - startedAt,
    });
    return errorResponse(safeError);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm infra:test -- session-handler && pnpm typecheck && pnpm lint`
Expected: PASS (6 tests). Check `wc -l infra/lambda/session-handler.ts infra/lambda/session-store.ts`: both are under 400.

- [ ] **Step 6: Commit**

```bash
git add infra/lambda/session-store.ts infra/lambda/session-handler.ts infra/test/session-handler.test.ts
git commit -m "feat(session): gate by access role, reserve voice quota, and record session history"
```

---

### Task 7: Mark history as grading when a session completes

**Files:**
- Modify: `infra/lambda/event-handler.ts:1-2, 28-35, 46-52, 75-136, 157-233, 286-296`
- Test: `infra/test/event-handler.test.ts` (append)

**Interfaces:**
- Consumes: `historyKey`, `HISTORY_SORT_PREFIX` (Task 3); `META.historySk` (Task 6).
- Produces: `buildAppendTransaction(input: AppendTransactionInput): TransactItem[]` (exported for tests); `AppendTransactionInput` as below. A completing batch also sets the history item to `status: "grading"` in the same transaction.

- [ ] **Step 1: Write the failing tests.** Append to `infra/test/event-handler.test.ts` and add `buildAppendTransaction` to the existing import from `../lambda/event-handler`:

```ts
describe("append transaction", () => {
  const historySk = `SESSION#2026-09-02T00:00:00.000Z#${sessionId}`;
  const base = {
    tableName: "sessions",
    sessionId,
    userId: "user-123",
    currentSequence: 0,
    currentEventCount: 0,
    appendGraceSeconds: PILOT_MAX_APPEND_GRACE_SECONDS,
    now: new Date("2026-09-02T00:05:00.000Z"),
  };
  const transcriptEvent: AppendEventBatch["events"][number] = {
    id: "0e8f2a4c-6b1d-4c3e-9f5a-1b2c3d4e5f60",
    sessionId,
    sequence: 1,
    occurredAt: "2026-09-02T00:01:00.000Z",
    type: "transcript.final",
    payload: { speaker: "candidate", text: "I would use a hash map.", evidenceId: "evidence:voice-1", startMs: 0, endMs: 1_000 },
  };

  it("moves the history item to grading when the batch completes the session", () => {
    const items = buildAppendTransaction({ ...base, events: completionBatch().events, historySk });
    expect(items).toHaveLength(4);
    const historyUpdate = items[3].Update;
    expect(historyUpdate?.Key).toEqual({ PK: "USER#user-123", SK: historySk });
    expect(historyUpdate?.ExpressionAttributeValues).toMatchObject({ ":grading": "grading" });
    expect(items[0].Update?.ExpressionAttributeValues).toMatchObject({ ":nextStatus": "completed" });
  });

  it("leaves history untouched for batches that do not complete the session", () => {
    const items = buildAppendTransaction({ ...base, events: [transcriptEvent], historySk });
    expect(items).toHaveLength(3);
    expect(JSON.stringify(items)).not.toContain("USER#");
  });

  it("skips history for sessions without a history item", () => {
    expect(buildAppendTransaction({ ...base, events: completionBatch().events })).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm infra:test -- event-handler`
Expected: FAIL — `buildAppendTransaction` is not exported.

- [ ] **Step 3: Update imports and records.** Line 2 becomes:

```ts
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
```

Add after the `./shared/logging` import:

```ts
import { HISTORY_SORT_PREFIX, historyKey } from "./shared/table-keys";
```

Add `historySk?: unknown;` to `SessionRecord` (lines 28–35) and `historySk?: string;` to `SessionState` (lines 46–52).

- [ ] **Step 4: Load `historySk` in `loadSessionState`.** Change its `ProjectionExpression` to:

```ts
    ProjectionExpression: "sessionId, userId, lastSequence, eventCount, sessionEndsAt, historySk, #status",
```

Add to the returned object:

```ts
    historySk: typeof session.historySk === "string" && session.historySk.startsWith(HISTORY_SORT_PREFIX)
      ? session.historySk
      : undefined,
```

- [ ] **Step 5: Replace `transactAppend` (lines 157–233)** with a pure builder plus a thin sender:

```ts
type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

export interface AppendTransactionInput {
  tableName: string;
  sessionId: string;
  userId: string;
  currentSequence: number;
  currentEventCount: number;
  events: readonly InterviewEvent[];
  appendGraceSeconds: number;
  historySk?: string;
  now: Date;
}

export function buildAppendTransaction(input: AppendTransactionInput): TransactItem[] {
  const lastAcceptedSequence = input.events.at(-1)?.sequence ?? input.currentSequence;
  const nextSequence = Math.max(input.currentSequence, lastAcceptedSequence);
  const completesSession = input.events.some((event) => event.type === "interview.completed");
  const receivedAt = input.now.toISOString();
  const minimumSessionEndsAt = new Date(input.now.getTime() - input.appendGraceSeconds * 1_000).toISOString();
  const mustNotExist = "attribute_not_exists(PK) AND attribute_not_exists(SK)";

  const items: TransactItem[] = [
    {
      Update: {
        TableName: input.tableName,
        Key: { PK: `SESSION#${input.sessionId}`, SK: "META" },
        UpdateExpression:
          "SET lastSequence = :nextSequence, eventCount = :nextEventCount, #status = :nextStatus, updatedAt = :updatedAt",
        ConditionExpression:
          "userId = :userId AND lastSequence = :currentSequence AND eventCount = :currentEventCount AND #status = :openStatus AND sessionEndsAt >= :minimumSessionEndsAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":userId": input.userId,
          ":currentSequence": input.currentSequence,
          ":nextSequence": nextSequence,
          ":currentEventCount": input.currentEventCount,
          ":nextEventCount": input.currentEventCount + input.events.length,
          ":openStatus": "created",
          ":nextStatus": completesSession ? "completed" : "created",
          ":minimumSessionEndsAt": minimumSessionEndsAt,
          ":updatedAt": receivedAt,
        },
      },
    },
    ...input.events.map((event): TransactItem => ({
      Put: {
        TableName: input.tableName,
        Item: {
          PK: `SESSION#${input.sessionId}`,
          SK: eventSortKey(event),
          entityType: "InterviewEvent",
          eventId: event.id,
          sessionId: event.sessionId,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          eventType: event.type,
          payload: event.payload,
          receivedAt,
        },
        ConditionExpression: mustNotExist,
      },
    })),
    ...input.events.map((event): TransactItem => ({
      Put: {
        TableName: input.tableName,
        Item: {
          PK: `SESSION#${input.sessionId}`,
          SK: `EVENT_ID#${event.id}`,
          entityType: "EventIdentity",
          eventId: event.id,
          sequence: event.sequence,
          createdAt: receivedAt,
        },
        ConditionExpression: mustNotExist,
      },
    })),
  ];

  if (completesSession && input.historySk) {
    items.push({
      Update: {
        TableName: input.tableName,
        Key: historyKey(input.userId, input.historySk),
        UpdateExpression: "SET #status = :grading, completedAt = :completedAt",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":grading": "grading", ":completedAt": receivedAt },
      },
    });
  }
  return items;
}

async function transactAppend(input: AppendTransactionInput): Promise<void> {
  if (input.events.length === 0) return;
  await documentClient.send(new TransactWriteCommand({ TransactItems: buildAppendTransaction(input) }));
}
```

The transaction holds at most 1 + 25 + 25 + 1 = 52 items, under DynamoDB's 100-item limit.

- [ ] **Step 6: Update the caller** in `appendWithOptimisticRetry` (lines 286–296):

```ts
      await transactAppend({
        tableName,
        sessionId: batch.sessionId,
        userId,
        currentSequence: state.lastSequence,
        currentEventCount: state.eventCount,
        events: validation.accepted,
        appendGraceSeconds,
        historySk: state.historySk,
        now,
      });
```

- [ ] **Step 7: Run the tests**

Run: `pnpm infra:test -- event-handler && pnpm typecheck`
Expected: PASS (existing and new tests).

- [ ] **Step 8: Commit**

```bash
git add infra/lambda/event-handler.ts infra/test/event-handler.test.ts
git commit -m "feat(events): mark session history as grading when evidence completes"
```

---

### Task 8: Grader writes history outcome and terminal failure

**Files:**
- Modify: `infra/lambda/grading-handler.ts` (edits below)
- Test: `infra/test/grading-handler.test.ts` (new)

**Interfaces:**
- Consumes: `overallScore` (Task 2); `historyKey`, `reportKey`, `sessionMetaKey`, `HISTORY_SORT_PREFIX` (Task 3); `emitMetric("grading_failed")` (Task 4); `META.historySk` (Task 6).
- Produces: `isFinalDeliveryAttempt(record: SqsRecord, maxReceiveCount: number): boolean` (exported); env `GRADING_MAX_RECEIVE_COUNT` (default 3; Task 11 sets it from the queue's `maxReceiveCount`). Report record `status: "failed"` on terminal failure; history `status: "graded"` with `overallScore`, or `status: "failed"`.

- [ ] **Step 1: Write the failing test** — `infra/test/grading-handler.test.ts`

```ts
/** @jest-environment node */
jest.mock("../lambda/shared/aws-clients", () => {
  const actual = jest.requireActual("../lambda/shared/aws-clients");
  return { ...actual, documentClient: { send: jest.fn() } };
});
jest.mock("../lambda/shared/gemini", () => ({
  gradeEvidence: jest.fn(),
  loadGeminiApiKey: jest.fn().mockResolvedValue("server-side-key"),
}));

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { handler, isFinalDeliveryAttempt } from "../lambda/grading-handler";
import { documentClient } from "../lambda/shared/aws-clients";
import { gradeEvidence } from "../lambda/shared/gemini";

const mockSend = documentClient.send as jest.Mock;
const mockGradeEvidence = gradeEvidence as jest.Mock;
const userId = "user-123";
const sessionId = "6a27e013-3d62-4828-a38d-177c0212399e";
const completionId = "50ca3ceb-038a-4f1a-a90c-401181531de8";
const transcriptId = "0e8f2a4c-6b1d-4c3e-9f5a-1b2c3d4e5f60";
const historySk = `SESSION#2026-09-02T00:00:00.000Z#${sessionId}`;

const storedEvents = [
  {
    eventId: transcriptId,
    sessionId,
    sequence: 1,
    occurredAt: "2026-09-02T00:01:00.000Z",
    eventType: "transcript.final",
    payload: { speaker: "candidate", text: "I would use a hash map.", evidenceId: "evidence:voice-1", startMs: 0, endMs: 1_000 },
  },
  {
    eventId: completionId,
    sessionId,
    sequence: 2,
    occurredAt: "2026-09-02T00:02:00.000Z",
    eventType: "interview.completed",
    payload: {
      reason: "user-ended",
      durationMs: 120_000,
      finalSequence: 2,
      evidenceSnapshotHash: "a".repeat(64),
      gradingRequested: true,
    },
  },
];

function scoreAt(score: number) {
  return {
    competency: `competency-${score}`,
    score,
    confidence: 0.8,
    evidenceReferences: [{ eventId: transcriptId, rationale: "Named a data structure." }],
    feedback: "State the complexity.",
    retryPrompt: "Explain the time complexity.",
  };
}

function sqsEvent(receiveCount: string) {
  return {
    Records: [{
      messageId: "message-1",
      body: JSON.stringify({ sessionId, userId, completionEventId: completionId }),
      attributes: { ApproximateReceiveCount: receiveCount },
    }],
  };
}

function sentCommands() {
  return mockSend.mock.calls.map(([command]) => command);
}

beforeEach(() => {
  process.env.TABLE_NAME = "sessions";
  delete process.env.GRADING_MAX_RECEIVE_COUNT;
  mockSend.mockReset();
  mockGradeEvidence.mockReset();
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof GetCommand) {
      return command.input.Key?.SK === "META"
        ? { Item: { userId, track: "algorithms", difficulty: "mid", historySk } }
        : {};
    }
    if (command instanceof QueryCommand) return { Items: storedEvents };
    return {};
  });
});

describe("grading outcomes", () => {
  it("records graded status and the overall score on the history item", async () => {
    mockGradeEvidence.mockResolvedValue({ summary: "Solid.", scores: [scoreAt(4), scoreAt(3)] });

    const result = await handler(sqsEvent("1"));

    expect(result.batchItemFailures).toEqual([]);
    const update = sentCommands().find((command) => command instanceof UpdateCommand) as UpdateCommand;
    expect(update.input.Key).toEqual({ PK: `USER#${userId}`, SK: historySk });
    expect(update.input.ExpressionAttributeValues).toEqual({ ":status": "graded", ":score": 3.5 });
  });

  it("marks the report and history failed on the final delivery attempt", async () => {
    mockGradeEvidence.mockRejectedValue(new Error("Gemini grading request failed."));

    const result = await handler(sqsEvent("3"));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "message-1" }]);
    const failedReport = sentCommands().find(
      (command) => command instanceof PutCommand && command.input.Item?.status === "failed",
    ) as PutCommand;
    expect(failedReport.input.Item).toMatchObject({ PK: `SESSION#${sessionId}`, SK: "REPORT#P1#v1" });
    const update = sentCommands().find((command) => command instanceof UpdateCommand) as UpdateCommand;
    expect(update.input.ExpressionAttributeValues).toEqual({ ":status": "failed" });
  });

  it("leaves earlier attempts retryable without marking failure", async () => {
    mockGradeEvidence.mockRejectedValue(new Error("Gemini grading request failed."));

    const result = await handler(sqsEvent("1"));

    expect(result.batchItemFailures).toHaveLength(1);
    expect(sentCommands().some((command) => command instanceof PutCommand && command.input.Item?.status === "failed"))
      .toBe(false);
  });
});

describe("final delivery detection", () => {
  it("compares the SQS receive count with the redrive limit", () => {
    expect(isFinalDeliveryAttempt({ messageId: "m", body: "{}", attributes: { ApproximateReceiveCount: "3" } }, 3)).toBe(true);
    expect(isFinalDeliveryAttempt({ messageId: "m", body: "{}", attributes: { ApproximateReceiveCount: "2" } }, 3)).toBe(false);
    expect(isFinalDeliveryAttempt({ messageId: "m", body: "{}" }, 3)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm infra:test -- grading-handler`
Expected: FAIL — `isFinalDeliveryAttempt` is not exported; no `UpdateCommand` is sent.

- [ ] **Step 3: Update imports and types** in `infra/lambda/grading-handler.ts`. Replace lines 2–12 with:

```ts
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ZodError } from "zod";
import { overallScore } from "../../src/lib/p1/report";
import { documentClient, positiveIntegerEnvironment, requiredEnvironment } from "./shared/aws-clients";
import {
  gradingMessageSchema,
  interviewEventSchema,
  type GradingMessage,
  type InterviewEvent,
} from "./shared/contracts";
import { gradeEvidence, loadGeminiApiKey } from "./shared/gemini";
import { baseLogMetadata, emitMetric, hashReference, writeSafeLog } from "./shared/logging";
import { HISTORY_SORT_PREFIX, historyKey, reportKey, sessionMetaKey } from "./shared/table-keys";
```

Change `SqsRecord` to export it and add attributes:

```ts
export interface SqsRecord {
  messageId: string;
  body: string;
  attributes?: { ApproximateReceiveCount?: string };
}
```

Add `historySk?: unknown;` to `SessionRecord`. Replace `const REPORT_SORT_KEY = "REPORT#P1#v1";` with:

```ts
const DEFAULT_MAX_RECEIVE_COUNT = 3;

type HistoryOutcome = { status: "graded"; overallScore: number } | { status: "failed" };
```

- [ ] **Step 4: Use the shared keys.** In `getSession`: `Key: sessionMetaKey(message.sessionId)` and `ProjectionExpression: "userId, track, difficulty, historySk"`. In `getReportRecord`: `Key: reportKey(sessionId)`. In `claimGrading` and in the final report `PutCommand`, replace `PK: \`SESSION#${...}\`, SK: REPORT_SORT_KEY,` with `...reportKey(sessionId),` and `...reportKey(message.sessionId),` respectively.

- [ ] **Step 5: Add the history and failure helpers** after `boundedEvidence`:

```ts
/**
 * The report record is authoritative; the history item is a derived index used for
 * listing sessions. A failed index update must never fail or repeat paid grading.
 */
async function recordHistoryOutcome(
  tableName: string,
  userId: string,
  historySk: unknown,
  outcome: HistoryOutcome,
): Promise<void> {
  if (typeof historySk !== "string" || !historySk.startsWith(HISTORY_SORT_PREFIX)) return;
  try {
    await documentClient.send(new UpdateCommand({
      TableName: tableName,
      Key: historyKey(userId, historySk),
      UpdateExpression: outcome.status === "graded"
        ? "SET #status = :status, overallScore = :score"
        : "SET #status = :status",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: outcome.status === "graded"
        ? { ":status": "graded", ":score": outcome.overallScore }
        : { ":status": "failed" },
    }));
  } catch {
    // Intentionally ignored; see the function comment.
  }
}

export function isFinalDeliveryAttempt(record: SqsRecord, maxReceiveCount: number): boolean {
  const receiveCount = Number(record.attributes?.ApproximateReceiveCount);
  return Number.isSafeInteger(receiveCount) && receiveCount >= maxReceiveCount;
}

async function markGradingFailed(message: GradingMessage, now: Date): Promise<void> {
  const tableName = requiredEnvironment("TABLE_NAME");
  try {
    await documentClient.send(new PutCommand({
      TableName: tableName,
      Item: {
        ...reportKey(message.sessionId),
        entityType: "EvidenceReport",
        status: "failed",
        failedAt: now.toISOString(),
        completionEventId: message.completionEventId,
      },
      ConditionExpression: "attribute_not_exists(PK) OR #status <> :complete",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":complete": "complete" },
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return;
    throw error;
  }
  const session = await getSession(tableName, message);
  await recordHistoryOutcome(tableName, message.userId, session.historySk, { status: "failed" });
  emitMetric("grading_failed", 1, "Count");
}
```

- [ ] **Step 6: Record the success outcome.** In `gradeMessage`, replace the final `return "success";` with:

```ts
  await recordHistoryOutcome(tableName, message.userId, session.historySk, {
    status: "graded",
    overallScore: overallScore(report),
  });
  return "success";
```

- [ ] **Step 7: Handle terminal failure in `handler`.** Add as the first line of `handler`:

```ts
  const maxReceiveCount = positiveIntegerEnvironment("GRADING_MAX_RECEIVE_COUNT", DEFAULT_MAX_RECEIVE_COUNT);
```

Inside the loop, declare `let message: GradingMessage | undefined;` next to `sessionRef`. Change the parse line to `message = gradingMessageSchema.parse(parsedBody);` and keep using `message` after it. In the `catch` block, before `failures.push(...)`, add:

```ts
      if (message && isFinalDeliveryAttempt(record, maxReceiveCount)) {
        try {
          await markGradingFailed(message, new Date());
        } catch {
          // The DLQ alarm still surfaces this message.
        }
      }
```

- [ ] **Step 8: Run the tests**

Run: `pnpm infra:test -- grading-handler && pnpm typecheck && pnpm lint`
Expected: PASS. `grading-handler.ts` stays under 400 lines.

- [ ] **Step 9: Commit**

```bash
git add infra/lambda/grading-handler.ts infra/test/grading-handler.test.ts
git commit -m "feat(grading): record graded or failed outcomes on session history"
```

---

### Task 9: Account Lambda (`/v1/me`, `/v1/sessions`, report read)

**Files:**
- Create: `infra/lambda/account-handler.ts`
- Test: `infra/test/account-handler.test.ts`

**Interfaces:**
- Consumes: `quotaKeys`, `userAllowance`, `AllowanceLimits`, `AccessRole`, `QuotaChannel`, `ItemKey` (Task 1); `meResponseSchema`, `sessionSummarySchema`, `sessionListResponseSchema`, `reportResponseSchema`, `SESSION_LIST_MAX_LIMIT` (Task 2); `authenticatedRole`, event `routeKey`/`pathParameters`/`queryStringParameters`, `allowanceLimitsFromEnvironment`, table keys (Task 3); log operation `account.read` (Task 4).
- Produces: `handler(event)` routing on `routeKey` values `"GET /v1/me"`, `"GET /v1/sessions"`, `"GET /v1/sessions/{sessionId}/report"` (Task 11 wires these exact route keys). Also `decodeCursor(cursor, userId)` and `encodeCursor(key)` (exported for tests).

- [ ] **Step 1: Write the failing test** — `infra/test/account-handler.test.ts`

```ts
/** @jest-environment node */
jest.mock("../lambda/shared/aws-clients", () => {
  const actual = jest.requireActual("../lambda/shared/aws-clients");
  return { ...actual, documentClient: { send: jest.fn() } };
});

import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "../lambda/account-handler";
import { documentClient } from "../lambda/shared/aws-clients";
import type { ApiGatewayV2Event } from "../lambda/shared/http";

const mockSend = documentClient.send as jest.Mock;
const userId = "user-1234";
const sessionId = "6a27e013-3d62-4828-a38d-177c0212399e";
const historySk = `SESSION#2026-09-15T10:00:00.000Z#${sessionId}`;
const eventId = "0e8f2a4c-6b1d-4c3e-9f5a-1b2c3d4e5f60";

function event(
  routeKey: string,
  extra: Partial<ApiGatewayV2Event> = {},
  groups: string | undefined = "[owner]",
): ApiGatewayV2Event {
  return {
    routeKey,
    requestContext: {
      requestId: "request-1",
      authorizer: { jwt: { claims: { sub: userId, ...(groups ? { "cognito:groups": groups } : {}) } } },
    },
    ...extra,
  };
}

function body(response: { body: string }) {
  return JSON.parse(response.body);
}

beforeEach(() => {
  process.env.TABLE_NAME = "sessions";
  mockSend.mockReset();
  jest.useFakeTimers({
    now: new Date("2026-09-15T12:00:00.000Z"),
    doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
  });
});

afterEach(() => jest.useRealTimers());

describe("GET /v1/me", () => {
  it("reports the role and per-channel allowances for the current UTC month", async () => {
    const used: Record<string, number> = { "QUOTA#GLOBAL#VOICE": 3, [`QUOTA#USER#${userId}#VOICE`]: 1 };
    mockSend.mockImplementation(async (command: GetCommand) => {
      const pk = String(command.input.Key?.PK);
      return used[pk] === undefined ? {} : { Item: { used: used[pk] } };
    });

    const response = await handler(event("GET /v1/me"));

    expect(response.statusCode).toBe(200);
    expect(body(response)).toEqual({
      role: "owner",
      quotas: {
        voice: { used: 1, limit: 10, globalRemaining: 7, resetsAt: "2026-10-01T00:00:00.000Z" },
        text: { used: 0, limit: 60, globalRemaining: 60, resetsAt: "2026-10-01T00:00:00.000Z" },
      },
    });
    expect(mockSend.mock.calls.every(([command]) => command.input.Key.SK === "MONTH#2026-09")).toBe(true);
  });

  it("gives an ungrouped account no allowance", async () => {
    mockSend.mockResolvedValue({});
    const response = await handler(event("GET /v1/me", {}, undefined));
    expect(body(response)).toMatchObject({ role: "none", quotas: { voice: { limit: 0 }, text: { limit: 0 } } });
  });
});

describe("GET /v1/sessions", () => {
  const storedItem = {
    PK: `USER#${userId}`,
    SK: historySk,
    entityType: "SessionHistory",
    sessionId,
    createdAt: "2026-09-15T10:00:00.000Z",
    channel: "voice",
    track: "algorithms",
    level: "mid",
    questionTitle: "Algorithms",
    status: "graded",
    overallScore: 3.5,
  };

  it("lists history newest first without storage keys and round-trips the cursor", async () => {
    mockSend.mockResolvedValue({ Items: [storedItem], LastEvaluatedKey: { PK: `USER#${userId}`, SK: historySk } });

    const first = body(await handler(event("GET /v1/sessions", { queryStringParameters: { limit: "1" } })));

    expect(first.items).toEqual([{
      sessionId,
      createdAt: "2026-09-15T10:00:00.000Z",
      channel: "voice",
      track: "algorithms",
      level: "mid",
      questionTitle: "Algorithms",
      status: "graded",
      overallScore: 3.5,
    }]);
    expect((mockSend.mock.calls[0][0] as QueryCommand).input).toMatchObject({
      ScanIndexForward: false,
      Limit: 1,
      ExpressionAttributeValues: { ":pk": `USER#${userId}`, ":prefix": "SESSION#" },
    });

    const second = await handler(event("GET /v1/sessions", { queryStringParameters: { cursor: first.nextCursor } }));
    expect(second.statusCode).toBe(200);
    expect((mockSend.mock.calls[1][0] as QueryCommand).input.ExclusiveStartKey).toEqual({
      PK: `USER#${userId}`,
      SK: historySk,
    });
  });

  it("rejects a cursor that points into another user's partition", async () => {
    const forged = Buffer.from(JSON.stringify({ PK: "USER#someone-else", SK: "SESSION#x" })).toString("base64url");
    const response = await handler(event("GET /v1/sessions", { queryStringParameters: { cursor: forged } }));
    expect(response.statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(["0", "51", "1.5", "abc"])("rejects limit=%s", async (limit) => {
    const response = await handler(event("GET /v1/sessions", { queryStringParameters: { limit } }));
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /v1/sessions/{sessionId}/report", () => {
  const reportRoute = "GET /v1/sessions/{sessionId}/report";

  function tableWith(meta: Record<string, unknown> | undefined, report: Record<string, unknown> | undefined) {
    mockSend.mockImplementation(async (command: GetCommand) =>
      command.input.Key?.SK === "META" ? { Item: meta } : { Item: report });
  }

  it("hides sessions owned by another user without reading the report", async () => {
    tableWith({ userId: "someone-else" }, undefined);
    const response = await handler(event(reportRoute, { pathParameters: { sessionId } }));
    expect(response.statusCode).toBe(404);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed session id without reading the table", async () => {
    const response = await handler(event(reportRoute, { pathParameters: { sessionId: "../../etc" } }));
    expect(response.statusCode).toBe(404);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns pending before grading starts", async () => {
    tableWith({ userId }, undefined);
    expect(body(await handler(event(reportRoute, { pathParameters: { sessionId } })))).toEqual({ status: "pending" });
  });

  it("returns the completed v1 report with its schema version", async () => {
    tableWith({ userId }, {
      status: "complete",
      createdAt: "2026-09-15T10:05:00.000Z",
      report: {
        summary: "Clear approach.",
        scores: [{
          competency: "Problem solving",
          score: 4,
          confidence: 0.8,
          evidenceReferences: [{ eventId, rationale: "Chose a hash map." }],
          feedback: "State the complexity.",
          retryPrompt: "Explain the complexity.",
        }],
      },
    });
    const result = body(await handler(event(reportRoute, { pathParameters: { sessionId } })));
    expect(result).toMatchObject({ status: "complete", gradedAt: "2026-09-15T10:05:00.000Z", report: { schemaVersion: 1 } });
  });

  it("maps a failed report", async () => {
    tableWith({ userId }, { status: "failed" });
    expect(body(await handler(event(reportRoute, { pathParameters: { sessionId } })))).toEqual({ status: "failed" });
  });
});

describe("routing and authentication", () => {
  it("returns 404 for unknown routes", async () => {
    expect((await handler(event("GET /v1/unknown"))).statusCode).toBe(404);
  });

  it("requires a signed-in caller", async () => {
    const anonymous: ApiGatewayV2Event = { routeKey: "GET /v1/me", requestContext: { requestId: "request-1" } };
    expect((await handler(anonymous)).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm infra:test -- account-handler`
Expected: FAIL — `Cannot find module '../lambda/account-handler'`.

- [ ] **Step 3: Implement** — `infra/lambda/account-handler.ts`

```ts
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  meResponseSchema,
  reportResponseSchema,
  SESSION_LIST_MAX_LIMIT,
  sessionListResponseSchema,
  sessionSummarySchema,
  type MeResponse,
  type ReportResponse,
  type SessionListResponse,
} from "../../src/lib/p1/account";
import { getUtcMonthWindow } from "../../src/lib/p1/quota";
import {
  quotaKeys,
  userAllowance,
  type AccessRole,
  type AllowanceLimits,
  type ItemKey,
  type QuotaChannel,
} from "../lib/access-policy";
import { allowanceLimitsFromEnvironment } from "./shared/allowances";
import { documentClient, requiredEnvironment } from "./shared/aws-clients";
import {
  authenticatedRole,
  authenticatedUserId,
  errorResponse,
  jsonResponse,
  SafeHttpError,
  type ApiGatewayV2Event,
  type ApiResponse,
} from "./shared/http";
import { baseLogMetadata, writeSafeLog } from "./shared/logging";
import { HISTORY_SORT_PREFIX, reportKey, sessionMetaKey } from "./shared/table-keys";

const OPERATION = "account.read" as const;
const DEFAULT_LIST_LIMIT = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;
const LIMIT_PATTERN = /^[1-9][0-9]?$/;

function notFound(): SafeHttpError {
  return new SafeHttpError(404, "session_not_found", "The interview session was not found.");
}

function invalidQuery(message: string): SafeHttpError {
  return new SafeHttpError(400, "invalid_request", message);
}

async function usedCount(tableName: string, key: ItemKey): Promise<number> {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: key,
    ProjectionExpression: "used",
  }));
  const used = (response.Item as { used?: unknown } | undefined)?.used;
  return typeof used === "number" && Number.isSafeInteger(used) && used >= 0 ? used : 0;
}

async function allowanceFor(input: {
  tableName: string;
  channel: QuotaChannel;
  userId: string;
  role: AccessRole;
  limits: AllowanceLimits;
  now: Date;
}) {
  const window = getUtcMonthWindow(input.now);
  const keys = quotaKeys(input.channel, input.userId, window.key);
  const [globalUsed, userUsed] = await Promise.all([
    usedCount(input.tableName, keys.global),
    usedCount(input.tableName, keys.user),
  ]);
  return {
    used: userUsed,
    limit: userAllowance(input.role, input.channel, input.limits),
    globalRemaining: Math.max(0, input.limits[input.channel].global - globalUsed),
    resetsAt: window.endsAt,
  };
}

async function me(tableName: string, userId: string, role: AccessRole, now: Date): Promise<MeResponse> {
  const limits = allowanceLimitsFromEnvironment();
  const [voice, text] = await Promise.all([
    allowanceFor({ tableName, channel: "voice", userId, role, limits, now }),
    allowanceFor({ tableName, channel: "text", userId, role, limits, now }),
  ]);
  return meResponseSchema.parse({ role, quotas: { voice, text } });
}

export function encodeCursor(key: ItemKey): string {
  return Buffer.from(JSON.stringify({ PK: key.PK, SK: key.SK }), "utf8").toString("base64url");
}

/** Only accepts a key inside the caller's own history partition (prevents IDOR via cursor). */
export function decodeCursor(cursor: string | undefined, userId: string): ItemKey | undefined {
  if (cursor === undefined) return undefined;
  const invalid = invalidQuery("The history cursor is invalid.");
  if (!CURSOR_PATTERN.test(cursor)) throw invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid;
  const { PK, SK, ...rest } = parsed as Record<string, unknown>;
  if (
    Object.keys(rest).length > 0 ||
    PK !== `USER#${userId}` ||
    typeof SK !== "string" ||
    !SK.startsWith(HISTORY_SORT_PREFIX) ||
    SK.length > 256
  ) throw invalid;
  return { PK, SK };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  const value = Number(raw);
  if (!LIMIT_PATTERN.test(raw) || value > SESSION_LIST_MAX_LIMIT) {
    throw invalidQuery(`limit must be between 1 and ${SESSION_LIST_MAX_LIMIT}.`);
  }
  return value;
}

function toSummary(item: Record<string, unknown>) {
  const { sessionId, createdAt, channel, track, level, questionTitle, status, overallScore } = item;
  const parsed = sessionSummarySchema.safeParse({
    sessionId,
    createdAt,
    channel,
    track,
    level,
    questionTitle,
    status,
    ...(overallScore === undefined ? {} : { overallScore }),
  });
  return parsed.success ? [parsed.data] : [];
}

async function listSessions(
  tableName: string,
  userId: string,
  query: ApiGatewayV2Event["queryStringParameters"],
): Promise<SessionListResponse> {
  const limit = parseLimit(query?.limit);
  const exclusiveStartKey = decodeCursor(query?.cursor, userId);
  const response = await documentClient.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": `USER#${userId}`, ":prefix": HISTORY_SORT_PREFIX },
    ScanIndexForward: false,
    Limit: limit,
    ExclusiveStartKey: exclusiveStartKey,
  }));
  const items = (response.Items ?? []).flatMap((item) => toSummary(item));
  const last = response.LastEvaluatedKey;
  const nextCursor = typeof last?.PK === "string" && typeof last.SK === "string"
    ? encodeCursor({ PK: last.PK, SK: last.SK })
    : undefined;
  return sessionListResponseSchema.parse({ items, ...(nextCursor ? { nextCursor } : {}) });
}

async function getReport(tableName: string, userId: string, sessionId: string | undefined): Promise<ReportResponse> {
  if (!sessionId || !UUID_PATTERN.test(sessionId)) throw notFound();
  const meta = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: sessionMetaKey(sessionId),
    ConsistentRead: true,
    ProjectionExpression: "userId",
  }));
  // Another user's session is indistinguishable from a missing one.
  if ((meta.Item as { userId?: unknown } | undefined)?.userId !== userId) throw notFound();

  const stored = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: reportKey(sessionId),
    ConsistentRead: true,
  }));
  const record = stored.Item as { status?: unknown; report?: unknown; createdAt?: unknown } | undefined;
  if (!record) return reportResponseSchema.parse({ status: "pending" });
  if (record.status === "failed") return reportResponseSchema.parse({ status: "failed" });
  if (record.status !== "complete" || !record.report || typeof record.report !== "object") {
    return reportResponseSchema.parse({ status: "grading" });
  }
  return reportResponseSchema.parse({
    status: "complete",
    report: { ...(record.report as Record<string, unknown>), schemaVersion: 1 },
    gradedAt: record.createdAt,
  });
}

function resultForError(error: unknown) {
  if (!(error instanceof SafeHttpError)) return "internal_error" as const;
  if (error.statusCode === 401) return "unauthorized" as const;
  if (error.statusCode === 404) return "not_found" as const;
  return "invalid_request" as const;
}

export async function handler(event: ApiGatewayV2Event): Promise<ApiResponse> {
  const startedAt = Date.now();
  try {
    const tableName = requiredEnvironment("TABLE_NAME");
    const userId = authenticatedUserId(event);
    const now = new Date();
    let payload: unknown;
    switch (event.routeKey) {
      case "GET /v1/me":
        payload = await me(tableName, userId, authenticatedRole(event), now);
        break;
      case "GET /v1/sessions":
        payload = await listSessions(tableName, userId, event.queryStringParameters);
        break;
      case "GET /v1/sessions/{sessionId}/report":
        payload = await getReport(tableName, userId, event.pathParameters?.sessionId);
        break;
      default:
        throw new SafeHttpError(404, "route_not_found", "The requested resource was not found.");
    }
    writeSafeLog({
      ...baseLogMetadata(),
      level: "INFO",
      operation: OPERATION,
      result: "success",
      requestId: event.requestContext.requestId,
      durationMs: Date.now() - startedAt,
    });
    return jsonResponse(200, payload);
  } catch (error) {
    writeSafeLog({
      ...baseLogMetadata(),
      level: error instanceof SafeHttpError && error.statusCode < 500 ? "WARN" : "ERROR",
      operation: OPERATION,
      result: resultForError(error),
      requestId: event.requestContext.requestId,
      durationMs: Date.now() - startedAt,
    });
    return errorResponse(error);
  }
}
```

The `ReportResponse` returned is the Zod-validated v1 shape; a corrupt stored report fails the parse and returns a safe 500 rather than leaking malformed data.

- [ ] **Step 4: Run the tests**

Run: `pnpm infra:test -- account-handler && pnpm typecheck && pnpm lint`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit and open PR-5**

```bash
git add infra/lambda/account-handler.ts infra/test/account-handler.test.ts
git commit -m "feat(account): add role/allowance, session history, and report read API"
git push
gh pr create --base feature/v2-phase1 --title "Phase 1: handlers" --body "Session role gate and voice quota with history, completion → grading, grader outcomes and terminal failure, and the new account Lambda. Tasks 6-9."
```

---

### Task 10: Deployment configuration

**Files:**
- Modify: `infra/lib/p1-config.ts` (full replacement), `infra/bin/p1.ts` (full replacement)
- Test: `infra/test/p1-config.test.ts` (full replacement)

**Interfaces:**
- Consumes: `HARD_LIMITS`, `readAllowanceLimits`, `AllowanceLimits` (Task 1).
- Produces: `P1Config { stageName; allowedOrigin; allowances: AllowanceLimits; voiceSessionMinutes: number; alertEmail?: string }`; `isProductionStage(stageName: string): boolean`; `assertAllowedOrigin` (unchanged). Env inputs: the six allowance variables, `VOICE_SESSION_MINUTES`, and `ALERT_EMAIL` (or context `alertEmail`). `ALERT_EMAIL` is required for `prod`.

- [ ] **Step 1: Write the failing test** — replace `infra/test/p1-config.test.ts`:

```ts
/** @jest-environment node */
import { assertAllowedOrigin, isProductionStage, resolveP1Config } from "../lib/p1-config";

const prodContext = { stage: "prod", allowedOrigin: "https://interviews.example.com" };

describe("P1 deployment configuration", () => {
  it("uses the documented defaults", () => {
    expect(resolveP1Config({}, {})).toEqual({
      stageName: "dev",
      allowedOrigin: "http://localhost:3000",
      allowances: {
        voice: { global: 10, owner: 10, guest: 2 },
        text: { global: 60, owner: 60, guest: 5 },
      },
      voiceSessionMinutes: 10,
      alertEmail: undefined,
    });
  });

  it("reads allowance overrides from the environment", () => {
    expect(resolveP1Config({}, { VOICE_GUEST_MONTHLY_LIMIT: "1" }).allowances.voice.guest).toBe(1);
  });

  it("requires an explicit HTTPS production origin", () => {
    expect(() => resolveP1Config({ stage: "prod" }, { NODE_ENV: "test" })).toThrow(/P1_ALLOWED_ORIGIN/);
    expect(() => assertAllowedOrigin("http://example.com", "prod")).toThrow(/HTTPS/);
    expect(assertAllowedOrigin("https://interviews.example.com", "prod")).toBe("https://interviews.example.com");
  });

  it("rejects wildcard origins and cost-cap bypasses", () => {
    expect(() => resolveP1Config({ allowedOrigin: "*" }, {})).toThrow(/wildcard/);
    expect(() => resolveP1Config({}, { VOICE_GLOBAL_MONTHLY_LIMIT: "11" })).toThrow(/hard cap/);
    expect(() => resolveP1Config({}, { TEXT_GLOBAL_MONTHLY_LIMIT: "61" })).toThrow(/hard cap/);
    expect(() => resolveP1Config({}, { VOICE_GLOBAL_MONTHLY_LIMIT: "5", VOICE_OWNER_MONTHLY_LIMIT: "6" }))
      .toThrow(/global limit/);
    expect(() => resolveP1Config({}, { VOICE_SESSION_MINUTES: "11" })).toThrow(/hard cap/);
    expect(() => resolveP1Config({}, { VOICE_GUEST_MONTHLY_LIMIT: "0" })).toThrow(/positive integer/);
  });

  it("requires a valid alert email for production", () => {
    expect(() => resolveP1Config(prodContext, {})).toThrow(/ALERT_EMAIL/);
    expect(() => resolveP1Config(prodContext, { ALERT_EMAIL: "not-an-email" })).toThrow(/valid email/);
    expect(resolveP1Config(prodContext, { ALERT_EMAIL: "alerts@example.com" }).alertEmail).toBe("alerts@example.com");
    expect(resolveP1Config({ ...prodContext, alertEmail: "ops@example.com" }, {}).alertEmail).toBe("ops@example.com");
  });

  it("identifies production stages", () => {
    expect(isProductionStage("prod")).toBe(true);
    expect(isProductionStage("production")).toBe(true);
    expect(isProductionStage("dev")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm infra:test -- p1-config`
Expected: FAIL — `isProductionStage` is not exported; the config shape differs.

- [ ] **Step 3: Replace `infra/lib/p1-config.ts`**

```ts
import { HARD_LIMITS, readAllowanceLimits, type AllowanceLimits } from "./access-policy";

export interface P1Config {
  stageName: string;
  allowedOrigin: string;
  allowances: AllowanceLimits;
  voiceSessionMinutes: number;
  alertEmail?: string;
}

const STAGE_PATTERN = /^[a-z][a-z0-9-]{0,19}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;

export function isProductionStage(stageName: string): boolean {
  return stageName === "prod" || stageName === "production";
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function assertAllowedOrigin(value: string, stageName: string): string {
  if (value === "*") throw new Error("P1_ALLOWED_ORIGIN must never be a wildcard.");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("P1_ALLOWED_ORIGIN must be an absolute HTTP(S) origin.");
  }

  if (url.origin !== value || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error("P1_ALLOWED_ORIGIN must contain only scheme, host, and optional port.");
  }

  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (isProductionStage(stageName) && url.protocol !== "https:") {
    throw new Error("Production P1_ALLOWED_ORIGIN must use HTTPS.");
  }
  if (url.protocol === "http:" && !isLocalhost) {
    throw new Error("Plain HTTP origins are allowed only for localhost development.");
  }

  return url.origin;
}

function resolveAlertEmail(raw: unknown, stageName: string): string | undefined {
  if (raw !== undefined && raw !== "" && (typeof raw !== "string" || !EMAIL_PATTERN.test(raw))) {
    throw new Error("ALERT_EMAIL must be a valid email address.");
  }
  const alertEmail = typeof raw === "string" && raw !== "" ? raw : undefined;
  if (isProductionStage(stageName) && !alertEmail) {
    throw new Error("ALERT_EMAIL is required for production deployments.");
  }
  return alertEmail;
}

export function resolveP1Config(
  context: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = process.env,
): P1Config {
  const stageName = String(context.stage ?? environment.DEPLOY_STAGE ?? "dev");
  if (!STAGE_PATTERN.test(stageName)) {
    throw new Error("stage must start with a letter and contain only lowercase letters, digits, or hyphens.");
  }

  const defaultOrigin = isProductionStage(stageName) ? undefined : "http://localhost:3000";
  const rawOrigin = context.allowedOrigin ?? environment.P1_ALLOWED_ORIGIN ?? defaultOrigin;
  if (typeof rawOrigin !== "string" || rawOrigin.length === 0) {
    throw new Error("P1_ALLOWED_ORIGIN is required for production deployments.");
  }

  const allowances = readAllowanceLimits((name, fallback) => positiveInteger(environment[name], fallback, name));
  const voiceSessionMinutes = positiveInteger(
    environment.VOICE_SESSION_MINUTES,
    HARD_LIMITS.voiceSessionMinutes,
    "VOICE_SESSION_MINUTES",
  );
  if (voiceSessionMinutes > HARD_LIMITS.voiceSessionMinutes) {
    throw new Error(`VOICE_SESSION_MINUTES cannot exceed the hard cap of ${HARD_LIMITS.voiceSessionMinutes}.`);
  }

  return {
    stageName,
    allowedOrigin: assertAllowedOrigin(rawOrigin, stageName),
    allowances,
    voiceSessionMinutes,
    alertEmail: resolveAlertEmail(context.alertEmail ?? environment.ALERT_EMAIL, stageName),
  };
}
```

- [ ] **Step 4: Replace `infra/bin/p1.ts`**

```ts
#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { P1Stack } from "../lib/p1-stack";
import { isProductionStage, resolveP1Config } from "../lib/p1-config";

const app = new cdk.App();
const config = resolveP1Config({
  stage: app.node.tryGetContext("stage"),
  allowedOrigin: app.node.tryGetContext("allowedOrigin"),
  alertEmail: app.node.tryGetContext("alertEmail"),
});

new P1Stack(app, `SignalRoom-${config.stageName}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "ap-southeast-1",
  },
  description: `Signal Room serverless application plane (${config.stageName})`,
  terminationProtection: isProductionStage(config.stageName),
  ...config,
});

app.synth();
```

Until Task 11 lands, `P1Stack` ignores the new config fields (object spreads skip excess-property checks), so this compiles.

- [ ] **Step 5: Run the tests**

Run: `pnpm infra:test -- p1-config && pnpm typecheck && pnpm infra:synth --context stage=test`
Expected: PASS; synth succeeds.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/p1-config.ts infra/bin/p1.ts infra/test/p1-config.test.ts
git commit -m "feat(config): channel allowances, voice duration cap, and production alert email"
```

---

### Task 12: Deployment workflows and invite scripts

**Files:**
- Modify: `.github/workflows/deploy-p1-aws.yml` (lines 8–18, 43–118, 236–243)
- Delete: `.github/workflows/deploy-amplify.yml`, `amplify.yml`
- Create: `scripts/invite-user.sh`, `scripts/invite-user.ps1`

**Interfaces:**
- Consumes: env names from Tasks 1 and 10 (`VOICE_*`, `TEXT_*`, `VOICE_SESSION_MINUTES`, `ALERT_EMAIL`); Cognito groups `owner`/`guest` (Task 11).
- Produces: GitHub environments `development` and `production` only. GitHub **variables** `VOICE_GLOBAL_MONTHLY_LIMIT`, `VOICE_OWNER_MONTHLY_LIMIT`, `VOICE_GUEST_MONTHLY_LIMIT`, `TEXT_GLOBAL_MONTHLY_LIMIT`, `TEXT_OWNER_MONTHLY_LIMIT`, `TEXT_GUEST_MONTHLY_LIMIT`, `VOICE_SESSION_MINUTES`, plus a production **secret** `ALERT_EMAIL`.

This task has no unit test. `pnpm infra:synth` exercises the same variables, and the first `development` run in Task 16 validates the workflow end to end.

- [ ] **Step 1: Restrict manual stages.** Replace the `options` list (lines 15–18) with:

```yaml
        options:
          - development
          - production
```

- [ ] **Step 2: Replace the job environment** (lines 43–56) with:

```yaml
    env:
      CI: "true"
      TESTED_REVISION: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}
      DEPLOY_ENVIRONMENT: ${{ github.event_name == 'workflow_dispatch' && inputs.stage || 'development' }}
      DEPLOY_STAGE: ${{ github.event_name == 'workflow_dispatch' && inputs.stage == 'production' && 'prod' || 'dev' }}
      AWS_DEPLOY_ROLE_ARN: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
      AWS_REGION: ${{ vars.AWS_REGION || 'ap-southeast-1' }}
      P1_ALLOWED_ORIGIN: ${{ vars.P1_ALLOWED_ORIGIN }}
      VOICE_GLOBAL_MONTHLY_LIMIT: ${{ vars.VOICE_GLOBAL_MONTHLY_LIMIT }}
      VOICE_OWNER_MONTHLY_LIMIT: ${{ vars.VOICE_OWNER_MONTHLY_LIMIT }}
      VOICE_GUEST_MONTHLY_LIMIT: ${{ vars.VOICE_GUEST_MONTHLY_LIMIT }}
      TEXT_GLOBAL_MONTHLY_LIMIT: ${{ vars.TEXT_GLOBAL_MONTHLY_LIMIT }}
      TEXT_OWNER_MONTHLY_LIMIT: ${{ vars.TEXT_OWNER_MONTHLY_LIMIT }}
      TEXT_GUEST_MONTHLY_LIMIT: ${{ vars.TEXT_GUEST_MONTHLY_LIMIT }}
      VOICE_SESSION_MINUTES: ${{ vars.VOICE_SESSION_MINUTES }}
      ALERT_EMAIL: ${{ secrets.ALERT_EMAIL }}
      P1_HEALTHCHECK_URL: ${{ vars.P1_HEALTHCHECK_URL }}
      P1_SMOKE_PATH: ${{ vars.P1_SMOKE_PATH || '/v1/realtime/sessions' }}
```

Empty variables fall back to the documented defaults inside `resolveP1Config`.

- [ ] **Step 3: Replace the "Validate deployment configuration" script** (lines 60–118) with:

```yaml
        run: |
          set -euo pipefail

          if [[ ! "$DEPLOY_ENVIRONMENT" =~ ^(development|production)$ ]]; then
            echo "::error::DEPLOY_ENVIRONMENT must be development or production."
            exit 1
          fi

          if [[ ! "$DEPLOY_STAGE" =~ ^(dev|prod)$ ]]; then
            echo "::error::DEPLOY_STAGE must resolve to dev or prod."
            exit 1
          fi

          if [[ "$DEPLOY_ENVIRONMENT" == "production" && "$GITHUB_REF_NAME" != "main" ]]; then
            echo "::error::Production deployments must run from the main branch."
            exit 1
          fi

          if [[ -z "$P1_ALLOWED_ORIGIN" ]]; then
            echo "::error::Set P1_ALLOWED_ORIGIN to this environment's exact web origin."
            exit 1
          fi

          if [[ "$DEPLOY_ENVIRONMENT" == "production" && -z "$ALERT_EMAIL" ]]; then
            echo "::error::Set the ALERT_EMAIL secret on the production environment."
            exit 1
          fi

          # Allowance and duration hard caps are enforced by resolveP1Config during
          # `pnpm infra:synth`, which runs before any deploy step.

          if [[ ! "$AWS_DEPLOY_ROLE_ARN" =~ ^arn:aws:iam::[0-9]{12}:role/.+ ]]; then
            echo "::error::Set AWS_DEPLOY_ROLE_ARN as a GitHub environment variable to the OIDC deployment role ARN."
            exit 1
          fi
          expected_account_id="${AWS_DEPLOY_ROLE_ARN#arn:aws:iam::}"
          expected_account_id="${expected_account_id%%:*}"
          echo "EXPECTED_AWS_ACCOUNT_ID=$expected_account_id" >> "$GITHUB_ENV"

          if [[ "$AWS_REGION" != "ap-southeast-1" ]]; then
            echo "::error::Signal Room is intentionally pinned to AWS Singapore (ap-southeast-1)."
            exit 1
          fi

          echo "RESOLVED_STACK_NAME=SignalRoom-$DEPLOY_STAGE" >> "$GITHUB_ENV"
```

- [ ] **Step 4: Update the smoke-test error text** (line 241) from "Staging and production deployments require …" to:

```bash
            echo "::error::Production deployments require P1_HEALTHCHECK_URL or a CDK API URL output."
```

Privacy note for the owner: the uploaded `cdk-diff` artifact includes the budget/SNS subscriber email. The same address already appears in public commit metadata, so this is accepted. Remove the "Upload CDK diff" step if that changes.

- [ ] **Step 5: Delete the unused Amplify path**

```bash
git rm .github/workflows/deploy-amplify.yml amplify.yml
```

Then run a grep for `amplify` over `.github/` and `package.json`. Expected: no remaining references (the README is updated in Task 14).

- [ ] **Step 6: Create `scripts/invite-user.sh`**

```bash
#!/usr/bin/env bash
# Invite a Signal Room user. Cognito emails a temporary password, then the user is
# added to the owner or guest group. Requires an AWS CLI profile for the account.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <user-pool-id> <email> <owner|guest>" >&2
  exit 2
fi

pool_id="$1"
email="$2"
group="$3"

[[ "$pool_id" =~ ^ap-southeast-1_[A-Za-z0-9]+$ ]] || { echo "Invalid user pool id." >&2; exit 2; }
[[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || { echo "Invalid email address." >&2; exit 2; }
[[ "$group" == "owner" || "$group" == "guest" ]] || { echo "Group must be owner or guest." >&2; exit 2; }

aws cognito-idp admin-create-user \
  --region ap-southeast-1 \
  --user-pool-id "$pool_id" \
  --username "$email" \
  --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL > /dev/null

aws cognito-idp admin-add-user-to-group \
  --region ap-southeast-1 \
  --user-pool-id "$pool_id" \
  --username "$email" \
  --group-name "$group"

echo "Invited $email as $group."
```

Then run `git update-index --chmod=+x scripts/invite-user.sh` so it stays executable on Windows checkouts.

- [ ] **Step 7: Create `scripts/invite-user.ps1`**

```powershell
# Invite a Signal Room user. Cognito emails a temporary password, then the user is
# added to the owner or guest group. Requires an AWS CLI profile for the account.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^ap-southeast-1_[A-Za-z0-9]+$')][string]$UserPoolId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[^\s@]+@[^\s@]+\.[^\s@]+$')][string]$Email,
  [Parameter(Mandatory = $true)][ValidateSet('owner', 'guest')][string]$Group
)
$ErrorActionPreference = 'Stop'

aws cognito-idp admin-create-user --region ap-southeast-1 --user-pool-id $UserPoolId --username $Email `
  --user-attributes "Name=email,Value=$Email" "Name=email_verified,Value=true" --desired-delivery-mediums EMAIL | Out-Null
if ($LASTEXITCODE -ne 0) { throw "admin-create-user failed." }

aws cognito-idp admin-add-user-to-group --region ap-southeast-1 --user-pool-id $UserPoolId --username $Email --group-name $Group
if ($LASTEXITCODE -ne 0) { throw "admin-add-user-to-group failed." }

Write-Output "Invited $Email as $Group."
```

- [ ] **Step 8: Validate and commit, then open PR-3**

Run: `bash -n scripts/invite-user.sh && pnpm infra:synth --context stage=test`
Expected: no syntax errors; synth succeeds.

```bash
git add .github/workflows/deploy-p1-aws.yml scripts/invite-user.sh scripts/invite-user.ps1
git commit -m "ci: two-stage AWS deploys with channel allowances; add invite scripts; drop Amplify"
git push -u origin feature/v2-phase1-infra
gh pr create --base feature/v2-phase1 --title "Phase 1: config and workflows" --body "New deployment config (allowances, voice cap, alert email), two-stage deploy workflow, invite scripts, Amplify removal. Tasks 10 and 12."
```

---

### Task 11: Lean CDK stack and production-only observability

Start after PR-3 and PR-5 are merged into `feature/v2-phase1`. Rebase `feature/v2-phase1-infra` first; CDK bundles `infra/lambda/account-handler.ts` at synth time.

**Files:**
- Create: `infra/lib/observability.ts`
- Modify: `infra/lib/p1-stack.ts` (full replacement)
- Test: `infra/test/p1-stack.test.ts` (full replacement)

**Interfaces:**
- Consumes: `allowanceEnvironment`, `DEFAULT_ALLOWANCE_LIMITS`, `HARD_LIMITS`, `validateAllowanceLimits`, `AllowanceLimits` (Task 1); `isProductionStage` and the `P1Config` field names (Task 10); Lambda env names `GEMINI_KEY_PARAMETER_NAME` (Task 5), `VOICE_SESSION_MINUTES` (Task 3), `GRADING_MAX_RECEIVE_COUNT` (Task 8); route keys (Task 9).
- Produces: `P1StackProps { stageName; allowedOrigin; allowances?; voiceSessionMinutes?; alertEmail? }`; `GRADING_MAX_RECEIVE_COUNT = 3`; `addProductionObservability(scope, input): cloudwatch.Dashboard`; `MONTHLY_BUDGET_USD = 1`; outputs `ApiUrl`, `UserPoolId`, `UserPoolClientId`, `CognitoDomain`, `GeminiKeyParameterName`, and in prod `DashboardName`.

- [ ] **Step 1: Write the failing test** — replace `infra/test/p1-stack.test.ts`:

```ts
/** @jest-environment node */
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { GRADING_MAX_RECEIVE_COUNT, P1Stack } from "../lib/p1-stack";

const templateCache = new Map<string, Template>();

function template(stageName = "test"): Template {
  const cached = templateCache.get(stageName);
  if (cached) return cached;
  const app = new cdk.App();
  const isProd = stageName === "prod";
  const stack = new P1Stack(app, `SignalRoom-${stageName}`, {
    env: { account: "111111111111", region: "ap-southeast-1" },
    stageName,
    allowedOrigin: isProd ? "https://interviews.example.com" : "http://localhost:3000",
    ...(isProd ? { alertEmail: "alerts@example.com" } : {}),
  });
  const synthesized = Template.fromStack(stack);
  templateCache.set(stageName, synthesized);
  return synthesized;
}

function alarmMetricCount(synthesized: Template): number {
  return Object.values(synthesized.findResources("AWS::CloudWatch::Alarm")).reduce((total, alarm) => {
    const metrics = alarm.Properties.Metrics as Array<{ MetricStat?: unknown }> | undefined;
    return total + (metrics ? metrics.filter((metric) => metric.MetricStat).length : 1);
  }, 0);
}

describe("lean P1 infrastructure", () => {
  it("creates invite-only auth with owner and guest groups", () => {
    const synthesized = template();
    synthesized.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    });
    synthesized.resourceCountIs("AWS::Cognito::UserPoolGroup", 2);
    synthesized.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "owner", Precedence: 0 });
    synthesized.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "guest", Precedence: 10 });
    synthesized.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      AllowedOAuthFlows: ["code"],
      CallbackURLs: ["http://localhost:3000/api/auth/callback"],
      GenerateSecret: false,
    });
  });

  it("removes resources that cost money or are unused", () => {
    const synthesized = template("prod");
    for (const type of [
      "AWS::SecretsManager::Secret",
      "AWS::S3::Bucket",
      "AWS::CodeDeploy::DeploymentGroup",
      "AWS::CodeDeploy::Application",
      "AWS::Lambda::Alias",
    ]) {
      synthesized.resourceCountIs(type, 0);
    }
  });

  it("protects every route with the Cognito JWT authorizer", () => {
    const synthesized = template();
    const routeKeys = [
      "POST /v1/realtime/sessions",
      "POST /v1/interview-events",
      "GET /v1/me",
      "GET /v1/sessions",
      "GET /v1/sessions/{sessionId}/report",
    ];
    synthesized.resourceCountIs("AWS::ApiGatewayV2::Route", routeKeys.length);
    for (const routeKey of routeKeys) {
      synthesized.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: routeKey, AuthorizationType: "JWT" });
    }
    expect(JSON.stringify(synthesized.findResources("AWS::ApiGatewayV2::Api"))).not.toContain('"*"');
  });

  it("keeps secrets and interview content out of Lambda configuration and API logs", () => {
    const synthesized = template();
    const functions = synthesized.findResources("AWS::Lambda::Function");
    expect(Object.keys(functions)).toHaveLength(4);
    let keyAwareFunctions = 0;
    for (const resource of Object.values(functions)) {
      const serialized = JSON.stringify(resource);
      expect(serialized).not.toContain("GEMINI_API_KEY");
      expect(serialized).not.toContain("transcript");
      if (serialized.includes("GEMINI_KEY_PARAMETER_NAME")) keyAwareFunctions += 1;
      expect(resource.Properties.TracingConfig).toEqual({ Mode: "Active" });
    }
    expect(keyAwareFunctions).toBe(2);

    const stage = Object.values(synthesized.findResources("AWS::ApiGatewayV2::Stage"))[0];
    const format = String(stage.Properties.AccessLogSettings.Format);
    expect(format).not.toMatch(/header|body|payload|token|transcript|audio|code|canvas/i);
  });

  it("grants the item actions DynamoDB transactions require, scoped to one table and one parameter", () => {
    const serialized = JSON.stringify(template().findResources("AWS::IAM::Policy"));
    expect(serialized).not.toMatch(/dynamodb:\*|ssm:\*|"Action":"\*"/);
    expect(serialized).not.toContain("dynamodb:TransactWriteItems");
    expect(serialized).not.toContain("secretsmanager:");
    for (const action of ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]) {
      expect(serialized).toContain(action);
    }
    expect(serialized).toContain("parameter/signal-room/test/gemini-api-key");
    expect(serialized).toContain("ssm.ap-southeast-1.amazonaws.com");
  });

  it("wires the grader's redrive limit to its failure detection", () => {
    const synthesized = template();
    synthesized.hasResourceProperties("AWS::SQS::Queue", {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: GRADING_MAX_RECEIVE_COUNT }),
    });
    expect(JSON.stringify(synthesized.findResources("AWS::Lambda::Function"))).toContain(
      `"GRADING_MAX_RECEIVE_COUNT":"${GRADING_MAX_RECEIVE_COUNT}"`,
    );
  });

  it("creates no alarms, dashboards, or budgets outside production", () => {
    const development = template();
    development.resourceCountIs("AWS::CloudWatch::Alarm", 0);
    development.resourceCountIs("AWS::CloudWatch::Dashboard", 0);
    development.resourceCountIs("AWS::Budgets::Budget", 0);
    for (const log of Object.values(development.findResources("AWS::Logs::LogGroup"))) {
      expect(log.Properties.RetentionInDays).toBe(7);
    }
  });

  it("keeps production monitoring inside the CloudWatch free tier and notifies by email", () => {
    const production = template("prod");
    production.resourceCountIs("AWS::CloudWatch::Alarm", 8);
    expect(alarmMetricCount(production)).toBeLessThanOrEqual(10);
    production.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    production.resourceCountIs("AWS::Budgets::Budget", 1);
    production.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "alerts@example.com" });
    for (const alarm of Object.values(production.findResources("AWS::CloudWatch::Alarm"))) {
      expect(alarm.Properties.AlarmActions).toHaveLength(1);
    }
    production.hasResourceProperties("AWS::DynamoDB::Table", {
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    for (const log of Object.values(production.findResources("AWS::Logs::LogGroup"))) {
      expect(log.Properties.RetentionInDays).toBe(30);
    }
  });

  it("refuses a production stack without an alert email", () => {
    expect(() => new P1Stack(new cdk.App(), "SignalRoom-prod-missing-email", {
      env: { account: "111111111111", region: "ap-southeast-1" },
      stageName: "prod",
      allowedOrigin: "https://interviews.example.com",
    })).toThrow(/alert email/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm infra:test -- p1-stack`
Expected: FAIL — `GRADING_MAX_RECEIVE_COUNT` is not exported; Secrets Manager, S3 and CodeDeploy resources still exist.

- [ ] **Step 3: Create `infra/lib/observability.ts`**

```ts
import { Duration } from "aws-cdk-lib";
import type * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

export const MONTHLY_BUDGET_USD = 1;

export interface ProductionObservabilityInput {
  stageName: string;
  api: apigwv2.HttpApi;
  functions: lambda.IFunction[];
  gradingDlq: sqs.IQueue;
  metricNamespace: string;
  alertEmail: string;
}

/**
 * Production-only monitoring sized for the CloudWatch free tier: 10 alarm metrics,
 * 10 custom metrics, and 3 dashboards per account. Every alarm has a single metric.
 */
export function addProductionObservability(
  scope: Construct,
  input: ProductionObservabilityInput,
): cloudwatch.Dashboard {
  const period = Duration.minutes(5);
  const api5xx = new cloudwatch.Metric({
    namespace: "AWS/ApiGateway",
    metricName: "5xx",
    dimensionsMap: { ApiId: input.api.apiId, Stage: "$default" },
    statistic: "Sum",
    period,
  });
  const applicationMetric = (metricName: string) => new cloudwatch.Metric({
    namespace: input.metricNamespace,
    metricName,
    dimensionsMap: { Environment: "production", Provider: "application" },
    statistic: "Sum",
    period,
  });
  const dlqDepth = input.gradingDlq.metricApproximateNumberOfMessagesVisible({ period, statistic: "Maximum" });

  const alertTopic = new sns.Topic(scope, "OperationsAlerts", {
    topicName: `signal-room-${input.stageName}-alerts`,
    enforceSSL: true,
  });
  alertTopic.addSubscription(new subscriptions.EmailSubscription(input.alertEmail));
  const notify = new cloudwatchActions.SnsAction(alertTopic);

  const alarms: Array<[string, cloudwatch.IMetric]> = [
    ["ApiServerErrors", api5xx],
    ...input.functions.map((fn): [string, cloudwatch.IMetric] => [`${fn.node.id}Errors`, fn.metricErrors({ period })]),
    ["GradingDlqDepth", dlqDepth],
    ["GradingFailures", applicationMetric("grading_failed")],
    ["SessionSetupFailures", applicationMetric("session_setup_failed")],
  ];
  for (const [id, metric] of alarms) {
    const alarm = new cloudwatch.Alarm(scope, `${id}Alarm`, {
      metric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(notify);
  }

  const dashboard = new cloudwatch.Dashboard(scope, "OperationsDashboard", {
    dashboardName: `signal-room-${input.stageName}`,
    defaultInterval: Duration.hours(24),
  });
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({ title: "HTTP API 5xx", left: [api5xx] }),
    new cloudwatch.GraphWidget({ title: "Lambda errors", left: input.functions.map((fn) => fn.metricErrors({ period })) }),
    new cloudwatch.GraphWidget({
      title: "Grading",
      left: [applicationMetric("grading_failed"), applicationMetric("session_setup_failed")],
      right: [dlqDepth],
    }),
  );

  new budgets.CfnBudget(scope, "MonthlyCostBudget", {
    budget: {
      budgetName: `signal-room-${input.stageName}-monthly`,
      budgetType: "COST",
      timeUnit: "MONTHLY",
      budgetLimit: { amount: MONTHLY_BUDGET_USD, unit: "USD" },
    },
    notificationsWithSubscribers: [
      {
        notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 80, thresholdType: "PERCENTAGE" },
        subscribers: [{ subscriptionType: "EMAIL", address: input.alertEmail }],
      },
      {
        notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" },
        subscribers: [{ subscriptionType: "EMAIL", address: input.alertEmail }],
      },
    ],
  });
  return dashboard;
}
```

The SNS topic is left unencrypted on purpose. CloudWatch alarms cannot publish to a topic encrypted with the AWS-managed `aws/sns` key, a customer-managed key costs $1/month, and alarm notifications carry only alarm names and states.

- [ ] **Step 4: Replace `infra/lib/p1-stack.ts`**

```ts
import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import {
  allowanceEnvironment,
  DEFAULT_ALLOWANCE_LIMITS,
  HARD_LIMITS,
  validateAllowanceLimits,
  type AllowanceLimits,
} from "./access-policy";
import { addProductionObservability } from "./observability";
import { isProductionStage } from "./p1-config";

export interface P1StackProps extends StackProps {
  stageName: string;
  allowedOrigin: string;
  allowances?: AllowanceLimits;
  voiceSessionMinutes?: number;
  alertEmail?: string;
}

interface FunctionResources {
  readonly fn: lambdaNodejs.NodejsFunction;
  readonly role: iam.Role;
}

type TableAction =
  | "dynamodb:GetItem"
  | "dynamodb:PutItem"
  | "dynamodb:UpdateItem"
  | "dynamodb:DeleteItem"
  | "dynamodb:Query";

const METRIC_NAMESPACE = "SignalRoom/P1";
const COGNITO_GROUPS = [
  { name: "owner", precedence: 0, description: "Project owner: full voice and text allowance" },
  { name: "guest", precedence: 10, description: "Invited guest: small voice and text allowance" },
] as const;
export const GRADING_MAX_RECEIVE_COUNT = 3;

export class P1Stack extends Stack {
  constructor(scope: Construct, id: string, props: P1StackProps) {
    super(scope, id, props);

    const isProduction = isProductionStage(props.stageName);
    const retention = isProduction ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK;
    const removalPolicy = isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const allowances = validateAllowanceLimits(props.allowances ?? DEFAULT_ALLOWANCE_LIMITS);
    const voiceSessionMinutes = props.voiceSessionMinutes ?? HARD_LIMITS.voiceSessionMinutes;

    if (props.allowedOrigin === "*") throw new Error("allowedOrigin must be explicit.");
    if (voiceSessionMinutes > HARD_LIMITS.voiceSessionMinutes) {
      throw new Error("Voice sessions cannot exceed the ten-minute hard cap.");
    }
    if (isProduction && !props.alertEmail) throw new Error("Production requires an alert email.");

    Tags.of(this).add("Application", "SignalRoom");
    Tags.of(this).add("Environment", props.stageName);
    Tags.of(this).add("ManagedBy", "AWS-CDK");

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `signal-room-${props.stageName}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireSymbols: true,
        requireUppercase: true,
        tempPasswordValidity: Duration.days(3),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy,
    });
    for (const group of COGNITO_GROUPS) {
      new cognito.CfnUserPoolGroup(this, `${group.name}Group`, {
        userPoolId: userPool.userPoolId,
        groupName: group.name,
        precedence: group.precedence,
        description: group.description,
      });
    }
    const userPoolClient = userPool.addClient("WebClient", {
      userPoolClientName: `signal-room-web-${props.stageName}`,
      generateSecret: false,
      authFlows: { userSrp: true },
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${props.allowedOrigin}/api/auth/callback`],
        logoutUrls: [`${props.allowedOrigin}/`],
      },
    });
    const userPoolDomain = userPool.addDomain("HostedDomain", {
      cognitoDomain: { domainPrefix: `signal-room-${props.stageName}-${this.account}` },
    });

    const table = new dynamodb.Table(this, "InterviewTable", {
      tableName: `signal-room-${props.stageName}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProduction },
      deletionProtection: isProduction,
      removalPolicy,
    });

    const gradingDlq = new sqs.Queue(this, "GradingDlq", {
      queueName: `signal-room-grading-dlq-${props.stageName}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy,
    });
    const gradingQueue = new sqs.Queue(this, "GradingQueue", {
      queueName: `signal-room-grading-${props.stageName}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.minutes(2),
      deadLetterQueue: { queue: gradingDlq, maxReceiveCount: GRADING_MAX_RECEIVE_COUNT },
      removalPolicy,
    });

    // Created manually once per stage (CloudFormation cannot create SecureString values).
    const geminiKeyParameterName = `/signal-room/${props.stageName}/gemini-api-key`;
    const baseEnvironment = {
      TABLE_NAME: table.tableName,
      ENVIRONMENT: props.stageName,
      LOG_NAMESPACE: METRIC_NAMESPACE,
    };

    const sessionFunction = this.createFunction("Session", props.stageName, retention, {
      entry: this.lambdaEntry("session-handler.ts"),
      timeout: Duration.seconds(15),
      memorySize: 512,
      reservedConcurrency: 5,
      environment: {
        ...baseEnvironment,
        ...allowanceEnvironment(allowances),
        GEMINI_KEY_PARAMETER_NAME: geminiKeyParameterName,
        GEMINI_LIVE_MODEL: "gemini-3.1-flash-live-preview",
        VOICE_SESSION_MINUTES: String(voiceSessionMinutes),
      },
    });
    const eventFunction = this.createFunction("Event", props.stageName, retention, {
      entry: this.lambdaEntry("event-handler.ts"),
      timeout: Duration.seconds(15),
      memorySize: 512,
      reservedConcurrency: 10,
      environment: {
        ...baseEnvironment,
        GRADING_QUEUE_URL: gradingQueue.queueUrl,
        MAX_SESSION_EVENTS: "500",
        SESSION_APPEND_GRACE_SECONDS: "120",
      },
    });
    const graderFunction = this.createFunction("Grader", props.stageName, retention, {
      entry: this.lambdaEntry("grading-handler.ts"),
      timeout: Duration.seconds(60),
      memorySize: 1_024,
      reservedConcurrency: 2,
      environment: {
        ...baseEnvironment,
        GEMINI_KEY_PARAMETER_NAME: geminiKeyParameterName,
        GEMINI_GRADER_MODEL: "gemini-2.5-flash-lite",
        GRADING_MAX_RECEIVE_COUNT: String(GRADING_MAX_RECEIVE_COUNT),
      },
    });
    const accountFunction = this.createFunction("Account", props.stageName, retention, {
      entry: this.lambdaEntry("account-handler.ts"),
      timeout: Duration.seconds(10),
      memorySize: 256,
      reservedConcurrency: 5,
      environment: { ...baseEnvironment, ...allowanceEnvironment(allowances) },
    });

    // DynamoDB authorizes transactions by their underlying item actions.
    this.grantTableActions(sessionFunction.role, table, [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    ]);
    this.grantTableActions(eventFunction.role, table, [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]);
    this.grantTableActions(graderFunction.role, table, [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    ]);
    this.grantTableActions(accountFunction.role, table, ["dynamodb:GetItem", "dynamodb:Query"]);
    this.grantGeminiKeyRead(sessionFunction.role, geminiKeyParameterName);
    this.grantGeminiKeyRead(graderFunction.role, geminiKeyParameterName);
    gradingQueue.grantSendMessages(eventFunction.role);
    gradingQueue.grantConsumeMessages(graderFunction.role);
    graderFunction.fn.addEventSource(new lambdaEventSources.SqsEventSource(gradingQueue, {
      batchSize: 5,
      maxBatchingWindow: Duration.seconds(5),
      reportBatchItemFailures: true,
    }));

    const api = this.createApi({
      stageName: props.stageName,
      allowedOrigin: props.allowedOrigin,
      retention,
      removalPolicy,
      userPool,
      userPoolClient,
      sessionFunction: sessionFunction.fn,
      eventFunction: eventFunction.fn,
      accountFunction: accountFunction.fn,
    });

    if (isProduction && props.alertEmail) {
      const dashboard = addProductionObservability(this, {
        stageName: props.stageName,
        api,
        functions: [sessionFunction.fn, eventFunction.fn, graderFunction.fn, accountFunction.fn],
        gradingDlq,
        metricNamespace: METRIC_NAMESPACE,
        alertEmail: props.alertEmail,
      });
      new CfnOutput(this, "DashboardName", { value: dashboard.dashboardName });
    }

    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "CognitoDomain", { value: userPoolDomain.baseUrl() });
    new CfnOutput(this, "GeminiKeyParameterName", { value: geminiKeyParameterName });
  }

  private createApi(input: {
    stageName: string;
    allowedOrigin: string;
    retention: logs.RetentionDays;
    removalPolicy: RemovalPolicy;
    userPool: cognito.UserPool;
    userPoolClient: cognito.UserPoolClient;
    sessionFunction: lambda.IFunction;
    eventFunction: lambda.IFunction;
    accountFunction: lambda.IFunction;
  }): apigwv2.HttpApi {
    const accessLogs = new logs.LogGroup(this, "ApiAccessLogs", {
      logGroupName: `/aws/apigateway/signal-room-${input.stageName}`,
      retention: input.retention,
      removalPolicy: input.removalPolicy,
    });
    accessLogs.grantWrite(new iam.ServicePrincipal("apigateway.amazonaws.com"));

    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `signal-room-${input.stageName}`,
      description: "Authenticated interview state, account, and Gemini session API",
      createDefaultStage: true,
      corsPreflight: {
        allowOrigins: [input.allowedOrigin],
        allowHeaders: ["authorization", "content-type", "idempotency-key"],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        maxAge: Duration.hours(1),
      },
    });
    const authorizer = new authorizers.HttpJwtAuthorizer(
      "CognitoJwt",
      `https://cognito-idp.${this.region}.amazonaws.com/${input.userPool.userPoolId}`,
      { jwtAudience: [input.userPoolClient.userPoolClientId] },
    );
    const accountIntegration = new integrations.HttpLambdaIntegration("AccountIntegration", input.accountFunction);
    const routes: Array<[string, apigwv2.HttpMethod, apigwv2.HttpRouteIntegration]> = [
      ["/v1/realtime/sessions", apigwv2.HttpMethod.POST, new integrations.HttpLambdaIntegration("SessionIntegration", input.sessionFunction)],
      ["/v1/interview-events", apigwv2.HttpMethod.POST, new integrations.HttpLambdaIntegration("EventIntegration", input.eventFunction)],
      ["/v1/me", apigwv2.HttpMethod.GET, accountIntegration],
      ["/v1/sessions", apigwv2.HttpMethod.GET, accountIntegration],
      ["/v1/sessions/{sessionId}/report", apigwv2.HttpMethod.GET, accountIntegration],
    ];
    for (const [routePath, method, integration] of routes) {
      api.addRoutes({ path: routePath, methods: [method], authorizer, integration });
    }

    const defaultStage = api.defaultStage;
    if (!defaultStage) throw new Error("The HTTP API default stage was not created.");
    const cfnStage = defaultStage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        routeKey: "$context.routeKey",
        status: "$context.status",
        integrationStatus: "$context.integration.status",
        integrationLatencyMs: "$context.integrationLatency",
        responseBytes: "$context.responseLength",
        authStatus: "$context.authorizer.status",
      }),
    };
    cfnStage.defaultRouteSettings = {
      detailedMetricsEnabled: true,
      throttlingBurstLimit: 20,
      throttlingRateLimit: 10,
    };
    cfnStage.node.addDependency(accessLogs);
    return api;
  }

  private lambdaEntry(fileName: string): string {
    const compiled = __dirname.split(path.sep).includes("dist");
    const infraRoot = path.resolve(__dirname, compiled ? "../.." : "..");
    return path.join(infraRoot, "lambda", fileName);
  }

  private createFunction(
    purpose: string,
    stageName: string,
    retention: logs.RetentionDays,
    options: {
      entry: string;
      timeout: Duration;
      memorySize: number;
      reservedConcurrency: number;
      environment: Record<string, string>;
    },
  ): FunctionResources {
    const functionName = `signal-room-${purpose.toLowerCase()}-${stageName}`;
    const logGroup = new logs.LogGroup(this, `${purpose}Logs`, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention,
      removalPolicy: isProductionStage(stageName) ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, `${purpose}Role`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: `Least-privilege execution role for the ${purpose.toLowerCase()} Lambda`,
    });
    logGroup.grantWrite(role);
    const fn = new lambdaNodejs.NodejsFunction(this, `${purpose}Function`, {
      functionName,
      entry: options.entry,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: options.memorySize,
      timeout: options.timeout,
      reservedConcurrentExecutions: options.reservedConcurrency,
      tracing: lambda.Tracing.ACTIVE,
      role,
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.INFO,
      environment: options.environment,
      depsLockFilePath: path.resolve(this.lambdaEntry(".."), "..", "pnpm-lock.yaml"),
      projectRoot: path.resolve(this.lambdaEntry(".."), ".."),
      bundling: {
        target: "node22",
        minify: true,
        sourceMap: false,
        sourcesContent: false,
        externalModules: [],
      },
    });
    fn.node.addDependency(logGroup);
    return { fn, role };
  }

  private grantTableActions(role: iam.Role, table: dynamodb.Table, actions: TableAction[]): void {
    role.addToPolicy(new iam.PolicyStatement({
      sid: "InterviewTableAccess",
      actions,
      resources: [table.tableArn],
    }));
  }

  private grantGeminiKeyRead(role: iam.Role, parameterName: string): void {
    role.addToPolicy(new iam.PolicyStatement({
      sid: "GeminiKeyParameterRead",
      actions: ["ssm:GetParameter"],
      resources: [this.formatArn({ service: "ssm", resource: "parameter", resourceName: parameterName.slice(1) })],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: "GeminiKeyDecryptViaSsm",
      actions: ["kms:Decrypt"],
      resources: [this.formatArn({ service: "kms", resource: "key", resourceName: "*" })],
      conditions: { StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` } },
    }));
  }
}
```

- [ ] **Step 5: Run the tests and check file sizes**

Run: `pnpm infra:test && pnpm typecheck && pnpm lint && pnpm infra:synth --context stage=test && wc -l infra/lib/p1-stack.ts infra/lib/observability.ts`
Expected: all PASS; `p1-stack.ts` is about 400 lines and `observability.ts` about 110.

- [ ] **Step 6: Commit and open PR-6**

```bash
git add infra/lib/p1-stack.ts infra/lib/observability.ts infra/test/p1-stack.test.ts
git commit -m "feat(infra): lean stack with invite-only groups, SSM key, account API, and prod-only monitoring"
git push
gh pr create --base feature/v2-phase1 --title "Phase 1: lean stack" --body "Removes Secrets Manager, S3, CodeDeploy canaries; fixes transaction IAM; adds Cognito groups, account routes, prod-only alarms with SNS email, and a \$1 AWS budget. Task 11."
```

---

### Task 13: Account BFF routes and the "not enabled" message

**Files:**
- Modify: `src/lib/server/p1-api.ts` (full replacement), `src/app/api/realtime/session/route.ts:24-30`, `src/app/api/auth/session/route.ts`, `src/components/interview-app.tsx:97, 135-152, 193-198, 459-461`
- Create: `src/lib/server/p1-read.ts`, `src/lib/server/contact-url.ts`, `src/app/api/me/route.ts`, `src/app/api/sessions/route.ts`, `src/app/api/sessions/[id]/report/route.ts`
- Test: `src/lib/server/p1-read.test.ts`, `src/lib/server/contact-url.test.ts`, `src/app/api/sessions/route.test.ts`, `src/app/api/sessions/[id]/report/route.test.ts`; append to `src/app/api/realtime/session/route.test.ts`

**Interfaces:**
- Consumes: `meResponseSchema`, `sessionListResponseSchema`, `reportResponseSchema` (Task 2); upstream routes (Tasks 9 and 11).
- Produces: `P1ApiPath` type; `callP1Api({ method?, path, accessToken, body?, query?, requestId, idempotencyKey? })`; `proxyP1Read({ path, query?, schema })`; `jsonError(status, error, message)`; BFF routes `GET /api/me`, `GET /api/sessions?limit&cursor`, `GET /api/sessions/[id]/report`; upstream 403 on session creation maps to `403 account_not_enabled`.

- [ ] **Step 1: Read the Next.js 16 route-handler docs.** Open the guide on route handlers and dynamic segments under `node_modules/next/dist/docs/` and confirm that the second route-handler argument is `{ params: Promise<{ id: string }> }`. If the docs show a different shape, use theirs in Step 8.

- [ ] **Step 2: Write the failing helper test** — `src/lib/server/p1-read.test.ts`

```ts
/** @jest-environment node */
jest.mock("@/lib/server/cognito-auth", () => ({ getAccessToken: jest.fn() }));

import { z } from "zod";
import { getAccessToken } from "@/lib/server/cognito-auth";
import { proxyP1Read } from "./p1-read";

const mockGetAccessToken = getAccessToken as jest.Mock;
const schema = z.object({ ok: z.literal(true) }).strict();
const originalP1Api = process.env.P1_API_URL;

afterEach(() => {
  if (originalP1Api === undefined) delete process.env.P1_API_URL;
  else process.env.P1_API_URL = originalP1Api;
  jest.restoreAllMocks();
  mockGetAccessToken.mockReset();
});

describe("proxyP1Read", () => {
  it("is unavailable when the protected API is not configured", async () => {
    delete process.env.P1_API_URL;
    const response = await proxyP1Read({ path: "/v1/me", schema });
    expect(response.status).toBe(404);
  });

  it("requires a signed-in session", async () => {
    process.env.P1_API_URL = "https://api.example.com";
    mockGetAccessToken.mockResolvedValue(undefined);
    expect((await proxyP1Read({ path: "/v1/me", schema })).status).toBe(401);
  });

  it("forwards a bodiless GET with the bearer token and validates the payload", async () => {
    process.env.P1_API_URL = "https://api.example.com";
    mockGetAccessToken.mockResolvedValue("access-token");
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));

    const response = await proxyP1Read({ path: "/v1/sessions", query: { limit: "5" }, schema });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.example.com/v1/sessions?limit=5");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
  });

  it.each([
    [403, 401],
    [404, 404],
    [400, 400],
    [500, 503],
  ])("maps upstream %i to %i without echoing upstream bodies", async (upstreamStatus, expected) => {
    process.env.P1_API_URL = "https://api.example.com";
    mockGetAccessToken.mockResolvedValue("access-token");
    jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ secret: "upstream-detail" }, { status: upstreamStatus }));

    const response = await proxyP1Read({ path: "/v1/me", schema });

    expect(response.status).toBe(expected);
    expect(await response.text()).not.toContain("upstream-detail");
  });

  it("fails closed when the upstream payload breaks the contract", async () => {
    process.env.P1_API_URL = "https://api.example.com";
    mockGetAccessToken.mockResolvedValue("access-token");
    jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, extra: "field" }));
    expect((await proxyP1Read({ path: "/v1/me", schema })).status).toBe(503);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test -- src/lib/server/p1-read.test.ts`
Expected: FAIL — `Cannot find module './p1-read'`.

- [ ] **Step 4: Replace `src/lib/server/p1-api.ts`**

```ts
import "server-only";

const MAX_UPSTREAM_RESPONSE_BYTES = 128 * 1024;
const P1_API_PATH =
  /^\/v1\/(?:realtime\/sessions|interview-events|me|sessions|sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/report)$/;

export type P1ApiPath =
  | "/v1/realtime/sessions"
  | "/v1/interview-events"
  | "/v1/me"
  | "/v1/sessions"
  | `/v1/sessions/${string}/report`;

function getP1ApiOrigin(): URL | undefined {
  const configured = process.env.P1_API_URL?.trim();
  if (!configured) return undefined;

  const url = new URL(configured);
  const isLocalDevelopment =
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocalDevelopment) {
    throw new Error("P1_API_URL must use HTTPS outside local development");
  }
  if (url.search || url.hash) throw new Error("P1_API_URL must not contain a query or fragment");
  return url;
}

export function isP1ApiEnabled(): boolean {
  return Boolean(getP1ApiOrigin());
}

export async function callP1Api(input: {
  method?: "GET" | "POST";
  path: P1ApiPath;
  accessToken: string;
  body?: unknown;
  query?: Record<string, string>;
  requestId: string;
  idempotencyKey?: string;
}): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const base = getP1ApiOrigin();
  if (!base) throw new Error("P1 API is not configured");
  // Defense in depth: callers build paths from validated IDs, and the upstream host is fixed.
  if (!P1_API_PATH.test(input.path)) throw new Error("Unsupported P1 API path");
  const method = input.method ?? "POST";
  if (method === "POST" && input.body === undefined) throw new Error("POST requests require a body");

  const url = new URL(input.path, base.origin);
  for (const [name, value] of Object.entries(input.query ?? {})) url.searchParams.set(name, value);
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.accessToken}`,
      "X-Request-Id": input.requestId,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(input.body) } : {}),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });

  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw new Error("P1 API response was too large");
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw new Error("P1 API response was too large");
  }

  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new Error("P1 API returned invalid JSON");
    }
  }

  return { ok: response.ok, status: response.status, payload };
}
```

- [ ] **Step 5: Create `src/lib/server/p1-read.ts`**

```ts
import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { getAccessToken } from "@/lib/server/cognito-auth";
import { callP1Api, isP1ApiEnabled, type P1ApiPath } from "@/lib/server/p1-api";

const noStoreHeaders = { "Cache-Control": "no-store", Vary: "Cookie" };

export function jsonError(status: number, error: string, message: string): NextResponse {
  return NextResponse.json({ error, message }, { status, headers: noStoreHeaders });
}

const unavailable = () => jsonError(503, "application_unavailable", "The interview service is temporarily unavailable.");
const signInRequired = () => jsonError(401, "authentication_required", "Sign in to continue.");

/**
 * Proxies an authenticated read to the P1 API. GET reads need no Origin check: the
 * access cookie is SameSite=Lax and scoped to /api, and responses carry no CORS headers.
 */
export async function proxyP1Read<T>(input: {
  path: P1ApiPath;
  query?: Record<string, string>;
  schema: z.ZodType<T>;
}): Promise<NextResponse> {
  if (!isP1ApiEnabled()) {
    return jsonError(404, "not_available", "Account features require the protected interview service.");
  }
  const accessToken = await getAccessToken();
  if (!accessToken) return signInRequired();

  try {
    const upstream = await callP1Api({
      method: "GET",
      path: input.path,
      query: input.query,
      accessToken,
      requestId: crypto.randomUUID(),
    });
    if (upstream.status === 401 || upstream.status === 403) return signInRequired();
    if (upstream.status === 404) return jsonError(404, "not_found", "The requested resource was not found.");
    if (upstream.status === 400) return jsonError(400, "invalid_request", "The request was rejected.");
    if (!upstream.ok) return unavailable();

    const parsed = input.schema.safeParse(upstream.payload);
    if (!parsed.success) return unavailable();
    return NextResponse.json(parsed.data, { headers: noStoreHeaders });
  } catch {
    return unavailable();
  }
}
```

- [ ] **Step 6: Run the helper test**

Run: `pnpm test -- src/lib/server/p1-read.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing route tests.**

`src/app/api/sessions/route.test.ts`:

```ts
/** @jest-environment node */
jest.mock("@/lib/server/p1-read", () => {
  const actual = jest.requireActual("@/lib/server/p1-read");
  return { ...actual, proxyP1Read: jest.fn(async () => new Response(null, { status: 204 })) };
});

import { proxyP1Read } from "@/lib/server/p1-read";
import { GET } from "./route";

const mockProxy = proxyP1Read as jest.Mock;

describe("GET /api/sessions", () => {
  beforeEach(() => mockProxy.mockClear());

  it.each(["0", "51", "1.5", "x"])("rejects limit=%s before calling upstream", async (limit) => {
    const response = await GET(new Request(`http://localhost/api/sessions?limit=${limit}`));
    expect(response.status).toBe(400);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("rejects a cursor outside the base64url alphabet", async () => {
    const response = await GET(new Request("http://localhost/api/sessions?cursor=abc%2Fdef"));
    expect(response.status).toBe(400);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("forwards only validated query parameters", async () => {
    await GET(new Request("http://localhost/api/sessions?limit=20&cursor=abc_DEF-1&extra=drop"));
    expect(mockProxy).toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1/sessions",
      query: { limit: "20", cursor: "abc_DEF-1" },
    }));
  });
});
```

`src/app/api/sessions/[id]/report/route.test.ts`:

```ts
/** @jest-environment node */
jest.mock("@/lib/server/p1-read", () => {
  const actual = jest.requireActual("@/lib/server/p1-read");
  return { ...actual, proxyP1Read: jest.fn(async () => new Response(null, { status: 204 })) };
});

import { proxyP1Read } from "@/lib/server/p1-read";
import { GET } from "./route";

const mockProxy = proxyP1Read as jest.Mock;
const context = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/sessions/[id]/report", () => {
  beforeEach(() => mockProxy.mockClear());

  it("rejects a malformed id without calling upstream", async () => {
    const response = await GET(new Request("http://localhost/api/sessions/x/report"), context("..%2Fme"));
    expect(response.status).toBe(404);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("normalizes the id to lowercase for the upstream path", async () => {
    await GET(new Request("http://localhost/api/sessions/x/report"), context("6A27E013-3D62-4828-A38D-177C0212399E"));
    expect(mockProxy).toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1/sessions/6a27e013-3d62-4828-a38d-177c0212399e/report",
    }));
  });
});
```

Append to `src/app/api/realtime/session/route.test.ts`. Add at the top of the file:

```ts
jest.mock("@/lib/server/cognito-auth", () => ({ getAccessToken: jest.fn() }));
import { getAccessToken } from "@/lib/server/cognito-auth";
```

Add inside the `describe` block:

```ts
  it("tells a signed-in account without a group that access is invite-only", async () => {
    process.env.P1_API_URL = "https://api.example.com";
    (getAccessToken as jest.Mock).mockResolvedValue("access-token");
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "account_not_enabled" }, { status: 403 }),
    );
    const response = await POST(request({
      track: "algorithms",
      difficulty: "mid",
      providerPreference: "gemini",
      durationMinutes: 10,
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "account_not_enabled" });
  });
```

- [ ] **Step 8: Create the routes.**

`src/app/api/me/route.ts`:

```ts
import { meResponseSchema } from "@/lib/p1/account";
import { proxyP1Read } from "@/lib/server/p1-read";

export const runtime = "nodejs";

export async function GET() {
  return proxyP1Read({ path: "/v1/me", schema: meResponseSchema });
}
```

`src/app/api/sessions/route.ts`:

```ts
import { sessionListResponseSchema } from "@/lib/p1/account";
import { jsonError, proxyP1Read } from "@/lib/server/p1-read";

export const runtime = "nodejs";

const LIMIT_PATTERN = /^(?:[1-9]|[1-4][0-9]|50)$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const limit = params.get("limit");
  const cursor = params.get("cursor");
  if ((limit !== null && !LIMIT_PATTERN.test(limit)) || (cursor !== null && !CURSOR_PATTERN.test(cursor))) {
    return jsonError(400, "invalid_request", "The history request was rejected.");
  }
  return proxyP1Read({
    path: "/v1/sessions",
    query: { ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) },
    schema: sessionListResponseSchema,
  });
}
```

`src/app/api/sessions/[id]/report/route.ts`:

```ts
import { reportResponseSchema } from "@/lib/p1/account";
import { jsonError, proxyP1Read } from "@/lib/server/p1-read";

export const runtime = "nodejs";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!SESSION_ID_PATTERN.test(id)) {
    return jsonError(404, "not_found", "The requested resource was not found.");
  }
  return proxyP1Read({ path: `/v1/sessions/${id.toLowerCase()}/report`, schema: reportResponseSchema });
}
```

- [ ] **Step 9: Map the upstream 403.** In `src/app/api/realtime/session/route.ts`, replace the first branch of `safeUpstreamError` (lines 25–30) with:

```ts
  if (status === 401) {
    return {
      status: 401,
      body: { error: "authentication_required", message: "Sign in to start a P1 interview." },
    };
  }
  if (status === 403) {
    return {
      status: 403,
      body: { error: "account_not_enabled", message: "This account has not been enabled yet. Access is invite-only." },
    };
  }
```

- [ ] **Step 10: Show the message in the UI.** In `src/components/interview-app.tsx`, after the `response.status === 401` block (line 196) insert:

```ts
      if (response.status === 403) throw new Error("This account has not been enabled yet. Access is invite-only.");
```

Then replace line 197 with:

```ts
      if (response.status === 429) throw new Error("This month's voice interview allowance has been used.");
```

- [ ] **Step 11: Add the "Request access" link (spec §4.3).** The link target comes from the server-only env var `CONTACT_URL`; only `https:` or `mailto:` values are exposed.

Test first — `src/lib/server/contact-url.test.ts`:

```ts
/** @jest-environment node */
import { resolveContactUrl } from "./contact-url";

describe("resolveContactUrl", () => {
  it.each([
    ["https://forms.example.com/signal-room", "https://forms.example.com/signal-room"],
    ["mailto:owner@example.com", "mailto:owner@example.com"],
  ])("exposes %s", (raw, expected) => {
    expect(resolveContactUrl(raw)).toBe(expected);
  });

  it.each([undefined, "", "javascript:alert(1)", "http://example.com", "mailto:not-an-email", "data:text/html,x"])(
    "hides %p",
    (raw) => {
      expect(resolveContactUrl(raw)).toBeUndefined();
    },
  );
});
```

Create `src/lib/server/contact-url.ts`:

```ts
import "server-only";

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;

/** Only https: and mailto: links are rendered, which blocks javascript:/data: URL injection. */
export function resolveContactUrl(raw = process.env.CONTACT_URL): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "mailto:" && EMAIL_PATTERN.test(decodeURIComponent(url.pathname))) return url.toString();
  return undefined;
}
```

In `src/app/api/auth/session/route.ts`, import `resolveContactUrl` and return:

```ts
  const contactUrl = resolveContactUrl();
  return NextResponse.json(
    { p1Enabled: isP1Configured(), authenticated: Boolean(accessToken), ...(contactUrl ? { contactUrl } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
```

In `src/components/interview-app.tsx`:
- Widen the `authStatus` state type to `{ p1Enabled: boolean; authenticated: boolean; contactUrl?: string }`.
- In the `/api/auth/session` effect, copy `contactUrl` only when it is a string starting with `https://` or `mailto:`.
- Directly below the sign-in `<a>` button, render the link when `authStatus?.contactUrl` is set:

```tsx
              {authStatus?.contactUrl && (
                <a className="setup-footnote" href={authStatus.contactUrl} rel="noopener noreferrer" target="_blank">
                  No account? Request access
                </a>
              )}
```

- [ ] **Step 12: Run all web checks**

Run: `pnpm test:ci && pnpm typecheck && pnpm lint && pnpm build && pnpm security:bundle`
Expected: PASS. `pnpm build` confirms Next.js accepts the new route handlers and the dynamic segment signature.

- [ ] **Step 13: Commit and open PR-4**

```bash
git add src/lib/server/p1-api.ts src/lib/server/p1-read.ts src/lib/server/p1-read.test.ts src/lib/server/contact-url.ts src/lib/server/contact-url.test.ts src/app/api/auth/session/route.ts src/app/api/me src/app/api/sessions src/app/api/realtime/session/route.ts src/app/api/realtime/session/route.test.ts src/components/interview-app.tsx
git commit -m "feat(web): add account read routes and invite-only messaging"
git push -u origin feature/v2-phase1-frontend
gh pr create --base feature/v2-phase1 --title "Phase 1: account BFF routes" --body "GET /api/me, /api/sessions, /api/sessions/[id]/report through a validated read proxy; 403 account_not_enabled messaging. Task 13."
```

---

### Task 14: Update `architecture.md` and `README.md`

Start after PR-1 to PR-6 are merged into `feature/v2-phase1`. Work in `.claude/worktrees/v2-docs` on `feature/v2-phase1-docs`.

**Files:**
- Modify: `architecture.md`, `README.md`

**Interfaces:**
- Consumes: every decision and name from Tasks 1–13.

- [ ] **Step 1: Header.** Set **Last updated** to the date this task runs. Change **Target** to `P0 local prototype plus v2 Phase 1 invite-only pilot (lean AWS)`.

- [ ] **Step 2: §2 "P1 indie pilot".** Replace the bullet list and the paragraph after it with:

```markdown
- Cognito sign-in using authorization code plus PKCE. Self sign-up is disabled; the owner invites accounts into the `owner` or `guest` group (`scripts/invite-user.*`). Accounts in neither group cannot start interviews (`403 account_not_enabled`).
- Constrained, short-lived Gemini Live credentials.
- Separate monthly allowances per UTC month. Voice: global hard cap **10**, owner 10, guest 2. Text: global hard cap **60**, owner 60, guest 5 (the text channel ships in Phase 2; its counters and limits exist now).
- A maximum duration of **10 minutes per voice interview**.
- Append-only transcript, code, canvas, scenario, usage, and lifecycle evidence.
- Asynchronous independent grading with evidence references persisted to DynamoDB.
- A read-only account API: role and allowances, session history, and the stored grading report. The browser does not render the report until Phase 2.
- CloudWatch alarms, a dashboard, and custom metrics in `prod` only, sized to the free tier, with email notification.

Hard caps are enforced in `infra/lib/access-policy.ts` at synthesis and at runtime, and in atomic DynamoDB transactions. Raising a hard cap is an architecture change.
```

- [ ] **Step 3: §4 topology.** Replace the `subgraph AWS` block with the one below. Remove the `Secret`/`Bucket` edges and add the Account edges.

```mermaid
  subgraph AWS[AWS ap-southeast-1]
    Cognito[Cognito Hosted UI, owner/guest groups]
    API[API Gateway HTTP API + JWT authorizer]
    SessionFn[Session Lambda]
    EventFn[Event Lambda]
    AccountFn[Account Lambda]
    DB[(DynamoDB)]
    Queue[SQS + DLQ]
    Grader[Grader Lambda]
    Param[SSM SecureString]
    Obs[CloudWatch + X-Ray, prod alarms → SNS email]
  end
```

Edges to add: `API --> AccountFn`, `AccountFn --> DB`, `SessionFn --> Param`, `Grader --> Param`. Edges to delete: `SessionFn --> Secret`, `Grader --> Secret`, `Bucket -.-> Browser`. Under the diagram, add: "`/api/me`, `/api/sessions`, and `/api/sessions/[id]/report` proxy authenticated GETs to the Account Lambda."

- [ ] **Step 4: §5 status table.** Update these rows:

| Area | Decision | Status |
|---|---|---|
| AWS application plane | CDK, API Gateway HTTP API, four ARM Node.js 22 Lambdas (session, event, grader, account) | Implemented; deployed in Task 16 |
| Identity | Cognito Hosted UI, code + PKCE, invite-only, `owner`/`guest` groups | Implemented |
| Secrets | SSM Parameter Store SecureString, AWS-managed `aws/ssm` key | Implemented |
| Object boundary | Removed; returns with recording consent | Removed |
| Operations | Prod-only: 8 single-metric alarms → SNS email, 1 dashboard, ≤ 10 EMF metrics, $1 AWS Budget; X-Ray everywhere | Implemented |
| Lambda release | Direct deploys; CodeDeploy canaries removed | Removed |

Delete the Amplify paragraph under the table.

- [ ] **Step 5: §6 credential boundaries.** Replace the second bullet with: "P1 session and grader Lambdas read the key from the SSM SecureString `/signal-room/<stage>/gemini-api-key` (`GEMINI_KEY_PARAMETER_NAME`) and cache it per container for five minutes."

- [ ] **Step 6: §7 authentication.** Append step 8: "The access tier comes from the `cognito:groups` claim of the Cognito-signed access token. The HTTP API authorizer flattens it to a string such as `[owner guest]`; `owner` wins over `guest`, and anything else resolves to `none`."

- [ ] **Step 7: §8 contracts.** Add a subsection "Account API (read-only)" containing the three response shapes from spec §4.5 (use `src/lib/p1/account.ts` as the source), plus these rules: report reads return 404 for another user's session; `GET /v1/sessions` cursors are opaque base64url keys rejected unless inside the caller's partition; `limit` is 1–50. Note that session creation returns `403 account_not_enabled` for role `none` and `429 monthly_quota_exhausted` when the voice allowance is used.

- [ ] **Step 8: §9 DynamoDB.** Replace the two quota rows and add the history row:

| Entity | PK | SK |
|---|---|---|
| Global quota | `QUOTA#GLOBAL#VOICE` or `QUOTA#GLOBAL#TEXT` | `MONTH#YYYY-MM` |
| User quota | `QUOTA#USER#cognito-sub#VOICE` or `…#TEXT` | `MONTH#YYYY-MM` |
| Session history | `USER#cognito-sub` | `SESSION#createdAtIso#sessionId` |

Add: "Session creation writes the history item (status `active`) in its quota transaction and stores `historySk` on `META`. Accepting completion sets `grading` in the append transaction. The grader sets `graded` (with `overallScore`) or, on the final SQS delivery, `failed`. The report is authoritative; history is a derived index. IAM grants the item actions (`PutItem`, `UpdateItem`, `DeleteItem`) that DynamoDB checks inside transactions."

- [ ] **Step 9: §11 privacy.** Delete the two S3 bullets. Add: "Invited guests' evidence is retained until deletion; the per-session delete endpoint ships in Phase 2."

- [ ] **Step 10: §12 observability.** Replace the "Implemented" list with:

```markdown
- API Gateway JSON access logs (no headers or bodies) and strict Lambda JSON logs in every stage.
- Active X-Ray tracing in every stage.
- `prod` only: eight single-metric alarms (API 5xx; errors for each of the four Lambdas; DLQ depth; `grading_failed`; `session_setup_failed`) that notify an SNS email topic; one dashboard; EMF custom metrics (at most 10); a $1 monthly AWS Budget with 80% forecast and 100% actual email alerts.
- `dev` emits no custom metrics, alarms, or dashboards, because the CloudWatch free tier is per account.
- A CDK test fails if production alarm metrics exceed 10 or if Secrets Manager, S3, or CodeDeploy resources return.
```

- [ ] **Step 11: §13 cost.** Replace the ten-session table with spec §8's table and the "measure then lower" rule. Change the AWS lines to: Secrets Manager → "SSM Parameter Store standard: $0"; CloudWatch → "$0 within free tier (prod only)"; AWS application plane → "about $0–0.30/month".

- [ ] **Step 12: §14 CI/CD.** Rewrite the second and third paragraphs to say:
  - Two GitHub environments exist, `development` (auto-deploy when `P1_AWS_DEPLOY_ENABLED=true`) and `production` (manual, `main` only, reviewer-gated).
  - Allowance and duration caps are validated by `resolveP1Config` during synth.
  - Deploy AWS before Vercel and keep `/v1` backward-compatible; there is no coordinated two-plane rollback.
  - The Amplify workflow was removed.

- [ ] **Step 13: §15–16 testing.** Update the test counts from the output of `pnpm test:ci` and `pnpm infra:test`. List the new coverage: access policy, account contracts, account handler (IDOR, cursor tampering), grader outcomes, history transactions, prod-only EMF, and lean-stack assertions.

- [ ] **Step 14: §17 decision log.** Append these rows, dated the day of this task:

| Decision | Rationale |
|---|---|
| Keep Vercel + AWS, trimmed to always-free limits; defer OpenNext on AWS | Least rework, keeps the AWS story, product work starts sooner |
| Invite-only Cognito with `owner`/`guest` groups | Shareable link without abuse or spend exposure |
| Separate voice (≤10) and text (≤60) monthly allowances | Voice is scarce; text makes daily practice affordable |
| Replace Secrets Manager with an SSM SecureString | $0.40/month to $0 |
| Prod-only alarms (≤10 metrics) with SNS email and a $1 budget | CloudWatch free tier is per account; alarms need a notification path |
| Remove CodeDeploy canaries, staging, S3 bucket, and Amplify | Solo-maintenance overhead with no benefit at this scale |
| Grant underlying item actions instead of `dynamodb:TransactWriteItems` | DynamoDB authorizes transactions by their item actions |

- [ ] **Step 15: `README.md`.** Make these edits:
  - Intro paragraph: replace the P1 sentence with one describing the invite-only v2 Phase 1 pilot.
  - "What works": add bullets for owner/guest tiers, voice/text allowances, the account API, and prod-only monitoring. Remove the "not yet read by the browser" clause only if Phase 2 has shipped (it has not; keep it).
  - "Deploy": replace steps 1–4 with the Task 16 runbook commands (bootstrap, create the SSM parameter with `read -rs`, deploy, invite yourself as `owner`, configure the BFF env).
  - "GitHub CI/CD → AWS environments": replace the variable list with the Task 12 variables and the `ALERT_EMAIL` secret; environments are `development` and `production`.
  - "Vercel production": delete the Amplify sentence.
  - "Current cost ceiling": use spec §8's table.
  - "Next steps": replace with (1) Task 16 checkpoint, (2) Phase 2 plan (question bank, interviewer module, text channel, report UI, history UI), (3) Phase 3 differentiators.

- [ ] **Step 16: Check and commit**

Run: `git grep -n -i -E "secrets manager|amplify|staging|GEMINI_SECRET_ARN|GLOBAL_MONTHLY_INTERVIEW_LIMIT" -- architecture.md README.md`
Expected: matches only in historical decision-log rows.

```bash
git add architecture.md README.md
git commit -m "docs: record v2 Phase 1 lean platform architecture"
```

---

### Task 15: Full verification, security audit, and the integration PR

**Files:** none new (fixes go in the task that owns the file).

- [ ] **Step 1: Run the full local acceptance suite** from the docs worktree on the fully merged `feature/v2-phase1`:

```bash
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm audit:deps && pnpm audit:prod && pnpm test:ci && pnpm infra:test && pnpm infra:synth --context stage=test && pnpm build && pnpm security:bundle && pnpm exec playwright install chromium && pnpm test:e2e
```

Expected: every command exits 0. Playwright's single mock journey still passes; no UI flow changed except error text.

- [ ] **Step 2: Check file sizes.**

```bash
git ls-files '*.ts' '*.tsx' | xargs wc -l | sort -n | awk '$1 > 450'
```

Expected: only files that were already over the limit before Phase 1 (`src/components/interview-app.tsx`, which Phase 2 splits) and possibly `infra/lambda/event-handler.ts`. Record any others and split them before merging.

- [ ] **Step 3: OWASP Top 10 audit of the Phase 1 diff** (`git diff main...feature/v2-phase1`). Confirm each item and write the result in the PR description:

| OWASP 2021 | Check | Where |
|---|---|---|
| A01 Broken access control | Report read returns 404 for another user's session; history cursor rejected outside the caller's partition; role comes only from the Cognito-signed token; ungrouped users get 403 | `account-handler.ts`, `session-handler.ts`, tests in Tasks 6 and 9 |
| A02 Cryptographic failures | Key in an SSM SecureString; no key in env, logs, or bundle (`security:bundle`); TLS-only SQS/SNS | Tasks 5 and 11 |
| A03 Injection | All DynamoDB access uses expression attribute values; path IDs validated by UUID regex before key construction; BFF path allowlist | Tasks 9 and 13 |
| A04 Insecure design | Hard caps enforced at synth and runtime plus in transactions; budget alert plus SNS | Tasks 1, 10, and 11 |
| A05 Security misconfiguration | Self sign-up off; CORS exact origin plus GET/POST only; no wildcard IAM actions; dev has no public extras | Task 11 tests |
| A07 Identification and authentication failures | Unchanged PKCE flow; access token still HttpOnly and scoped to `/api` | Task 13 |
| A08 Software and data integrity failures | Lockfile frozen; one-day release-age gate honored for `@aws-sdk/client-ssm` | Task 5 |
| A09 Logging and monitoring failures | Safe-log schema unchanged (no content); prod alarms notify by email | Tasks 4 and 11 |
| A10 SSRF | Upstream host fixed by `P1_API_URL`; path regex allowlist; `redirect: "error"` | Task 13 |

A06 (vulnerable components) is covered by `pnpm audit:deps` in Step 1.

- [ ] **Step 4: Push PR-7 and open the integration PR** (no Claude attribution in either):

```bash
git push -u origin feature/v2-phase1-docs
gh pr create --base feature/v2-phase1 --title "Phase 1: docs and verification" --body "architecture.md and README for the lean platform. Task 14; Task 15 audit results below."
gh pr create --base main --head feature/v2-phase1 --title "v2 Phase 1: lean platform and account API" --body "Implements spec §4 (docs/superpowers/specs/2026-09-15-signal-room-v2-design.md) via docs/superpowers/plans/2026-09-16-signal-room-v2-phase1.md. Includes the OWASP audit table from Task 15."
```

Merge the integration PR only after CI is green and the owner approves.

---

### Task 16: Deployment checkpoint (owner, manual)

Run from the main checkout on `main` after the integration PR merges. These steps create real AWS resources and use your credentials, so an agent must not run them.

- [ ] **Step 1: Bootstrap once**

```bash
pnpm exec cdk bootstrap aws://ACCOUNT_ID/ap-southeast-1
```

- [ ] **Step 2: Create the dev Gemini key parameter** (the key never enters shell history or the command line of a logged process):

```bash
read -rs GEMINI_KEY && aws ssm put-parameter --region ap-southeast-1 --name /signal-room/dev/gemini-api-key --type SecureString --value "$GEMINI_KEY" && unset GEMINI_KEY
```

- [ ] **Step 3: Deploy `dev` against a local web origin**

```bash
DEPLOY_STAGE=dev P1_ALLOWED_ORIGIN=http://localhost:3000 pnpm infra:deploy --context stage=dev
```

Expected: outputs `ApiUrl`, `UserPoolId`, `UserPoolClientId`, `CognitoDomain`, `GeminiKeyParameterName`.

- [ ] **Step 4: Invite yourself as owner and configure the local BFF**

```bash
./scripts/invite-user.sh <UserPoolId> <your-email> owner
```

In `.env.local` set `P1_API_URL=<ApiUrl>`, `APP_ORIGIN=http://localhost:3000`, `COGNITO_CLIENT_ID=<UserPoolClientId>`, and `COGNITO_DOMAIN=<CognitoDomain>`. Then run `pnpm dev`, sign in, and set a permanent password.

- [ ] **Step 5: Answer V4 (groups claim).** Open `http://localhost:3000/api/me` in the signed-in browser. Expected: `"role": "owner"`. If it shows `"none"`, the authorizer's claim format differs. Stop, and implement the spec's V4 fallback (`AdminListGroupsForUser`, cached for 5 minutes) before continuing.

- [ ] **Step 6: Run a real voice interview end to end.** Finish it, then open `/api/sessions` to get the session ID, and poll `/api/sessions/<id>/report` until it returns `"status": "complete"` (target: under 60 s). Expected: `/api/sessions` shows the session as `graded` with an `overallScore`.

- [ ] **Step 7: Check the tiers.** Invite a second address as `guest` and confirm its third voice session returns the 429 message. Create a third user **without** a group (`aws cognito-idp admin-create-user` only) and confirm that starting an interview returns the invite-only 403 message. Test in `dev` so these sessions do not use up the `prod` allowance.

- [ ] **Step 8: Deploy `prod`.**
  - Create `/signal-room/prod/gemini-api-key` (Step 2 with `prod`).
  - In GitHub, configure the `production` environment: `AWS_DEPLOY_ROLE_ARN`, `P1_ALLOWED_ORIGIN` (final Vercel origin), the allowance variables if not using defaults, and the `ALERT_EMAIL` secret.
  - Run "Deploy P1 AWS Application Plane" manually with `production`.
  - Confirm the SNS subscription email.
  - Set the Vercel production env (`P1_API_URL`, `APP_ORIGIN`, `COGNITO_CLIENT_ID`, `COGNITO_DOMAIN`) and run `deploy-vercel.yml`.

- [ ] **Step 9: Set up the Google Cloud budget.** In Google Cloud Console → Billing → Budgets & alerts, create a budget on the Gemini project with email alerts at $3 and $5. Restrict the API key to the Generative Language API.

- [ ] **Step 10: Record the results.** In `architecture.md` §17, add the V4 answer (claim format observed), the measured session-setup latency, and the first grading time. Commit on a branch and open a PR. Phase 1 exit criteria (spec §4.8) are then met. Next, write the Phase 2 plan, including the V1–V3 and V6 probes.
