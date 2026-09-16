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
