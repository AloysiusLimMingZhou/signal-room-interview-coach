/** @jest-environment node */
import {
  allowanceLimitsFromEnvironment,
  voiceSessionMinutesFromEnvironment,
} from "../lambda/shared/allowances";
import { authenticatedRole, type ApiGatewayV2Event } from "../lambda/shared/http";
import { historyKey, historySortKey, reportKey, sessionMetaKey } from "../lambda/shared/table-keys";

const ENV_NAMES = ["VOICE_GLOBAL_MONTHLY_LIMIT", "VOICE_GUEST_MONTHLY_LIMIT", "VOICE_SESSION_MINUTES", "TEXT_GLOBAL_MONTHLY_LIMIT"] as const;
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

  it("rejects oversized signed group strings at the Lambda boundary", () => {
    expect(authenticatedRole(eventWithGroups(`[owner ${"x".repeat(1_024)}]`))).toBe("none");
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

  it("enforces the text hard cap at the Lambda boundary", () => {
    process.env.TEXT_GLOBAL_MONTHLY_LIMIT = "61";
    expect(() => allowanceLimitsFromEnvironment()).toThrow(/hard cap of 60/);
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
