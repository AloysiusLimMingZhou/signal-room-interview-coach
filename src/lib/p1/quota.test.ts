import { evaluatePilotQuota, getUtcMonthWindow, resolvePilotQuota } from "./quota";

describe("pilot quota", () => {
  it("uses exact UTC month boundaries independently of local time", () => {
    expect(getUtcMonthWindow(new Date("2026-08-31T23:59:59.999Z"))).toEqual({
      key: "2026-08",
      startsAt: "2026-08-01T00:00:00.000Z",
      endsAt: "2026-09-01T00:00:00.000Z",
    });
    expect(getUtcMonthWindow(new Date("2026-09-01T00:00:00.000Z")).key).toBe("2026-09");
  });

  it("reserves the tenth session and then enforces the global cap", () => {
    expect(
      evaluatePilotQuota({
        now: new Date("2026-09-01T00:00:00.000Z"),
        usedSessions: 9,
        requestedDurationMinutes: 10,
      }),
    ).toMatchObject({ allowed: true, remainingAfterReservation: 0 });

    expect(
      evaluatePilotQuota({
        now: new Date("2026-09-30T23:59:59.999Z"),
        usedSessions: 10,
        requestedDurationMinutes: 10,
      }),
    ).toMatchObject({ allowed: false, reason: "monthly-session-limit", remaining: 0 });
  });

  it("rejects duration beyond the configured maximum", () => {
    expect(
      evaluatePilotQuota({
        now: new Date("2026-09-01T00:00:00.000Z"),
        usedSessions: 0,
        requestedDurationMinutes: 6,
        limits: { maxDurationMinutes: 5 },
      }),
    ).toMatchObject({ allowed: false, reason: "duration-limit" });
  });

  it("fails closed for invalid counters and quota configuration", () => {
    expect(() =>
      evaluatePilotQuota({
        now: new Date("invalid"),
        usedSessions: 0,
        requestedDurationMinutes: 10,
      }),
    ).toThrow("valid date");
    expect(() =>
      evaluatePilotQuota({
        now: new Date(),
        usedSessions: -1,
        requestedDurationMinutes: 10,
      }),
    ).toThrow("usedSessions");
    expect(() => resolvePilotQuota({ maxDurationMinutes: 11 })).toThrow();
  });
});
