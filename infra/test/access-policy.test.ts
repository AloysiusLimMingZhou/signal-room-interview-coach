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
    expect(() => validateAllowanceLimits(limits({ voice: { guest: -1 } }))).toThrow(/positive integer/);
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
