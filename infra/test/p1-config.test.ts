/** @jest-environment node */
import { assertAllowedOrigin, resolveP1Config } from "../lib/p1-config";

describe("P1 deployment configuration", () => {
  it("uses the bounded indie-pilot defaults", () => {
    expect(resolveP1Config({})).toMatchObject({
      stageName: "dev",
      allowedOrigin: "http://localhost:3000",
      globalMonthlyInterviewLimit: 10,
      userMonthlyInterviewLimit: 10,
      sessionDurationMinutes: 10,
    });
  });

  it("requires an explicit HTTPS production origin", () => {
    expect(() => resolveP1Config({ stage: "prod" }, { NODE_ENV: "test" })).toThrow(/P1_ALLOWED_ORIGIN/);
    expect(() => assertAllowedOrigin("http://example.com", "prod")).toThrow(/HTTPS/);
    expect(assertAllowedOrigin("https://interviews.example.com", "prod")).toBe(
      "https://interviews.example.com",
    );
  });

  it("rejects wildcard origins and cost-cap bypasses", () => {
    expect(() => resolveP1Config({ allowedOrigin: "*" })).toThrow(/wildcard/);
    expect(() => resolveP1Config({ globalMonthlyInterviewLimit: 11 })).toThrow(/hard cap/);
    expect(() => resolveP1Config({ userMonthlyInterviewLimit: 10, globalMonthlyInterviewLimit: 5 })).toThrow(
      /global limit/,
    );
    expect(() => resolveP1Config({ sessionDurationMinutes: 11 })).toThrow(/hard cap/);
  });
});
