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

  it.each([
    { VOICE_GLOBAL_MONTHLY_LIMIT: "5", VOICE_OWNER_MONTHLY_LIMIT: "6" },
    { VOICE_GLOBAL_MONTHLY_LIMIT: "5", VOICE_OWNER_MONTHLY_LIMIT: "5", VOICE_GUEST_MONTHLY_LIMIT: "6" },
    { TEXT_GLOBAL_MONTHLY_LIMIT: "20", TEXT_OWNER_MONTHLY_LIMIT: "21" },
    { TEXT_GLOBAL_MONTHLY_LIMIT: "20", TEXT_OWNER_MONTHLY_LIMIT: "20", TEXT_GUEST_MONTHLY_LIMIT: "21" },
  ])("rejects a role allowance above its channel limit: %p", (environment) => {
    expect(() => resolveP1Config({}, environment)).toThrow(/global limit/);
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
