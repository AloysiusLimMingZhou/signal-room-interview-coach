import { z } from "zod";

export const DEFAULT_PILOT_QUOTA = Object.freeze({
  sessionsPerUtcMonth: 10,
  maxDurationMinutes: 10,
});

export const pilotQuotaSchema = z
  .object({
    sessionsPerUtcMonth: z.number().int().min(1).max(1_000),
    maxDurationMinutes: z.number().int().min(1).max(10),
  })
  .strict();

export type PilotQuota = z.infer<typeof pilotQuotaSchema>;

export interface UtcMonthWindow {
  key: string;
  startsAt: string;
  endsAt: string;
}
export type QuotaDecision =
  | {
      allowed: true;
      remainingAfterReservation: number;
      limits: PilotQuota;
      window: UtcMonthWindow;
    }
  | {
      allowed: false;
      reason: "monthly-session-limit" | "duration-limit";
      remaining: number;
      limits: PilotQuota;
      window: UtcMonthWindow;
    };

export function resolvePilotQuota(overrides: Partial<PilotQuota> = {}): PilotQuota {
  return pilotQuotaSchema.parse({ ...DEFAULT_PILOT_QUOTA, ...overrides });
}

export function getUtcMonthWindow(now: Date): UtcMonthWindow {
  if (Number.isNaN(now.getTime())) {
    throw new TypeError("A valid date is required");
  }

  const startsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const endsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  return {
    key: `${startsAt.getUTCFullYear()}-${String(startsAt.getUTCMonth() + 1).padStart(2, "0")}`,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

export function evaluatePilotQuota(input: {
  now: Date;
  usedSessions: number;
  requestedDurationMinutes: number;
  limits?: Partial<PilotQuota>;
}): QuotaDecision {
  const limits = resolvePilotQuota(input.limits);
  const window = getUtcMonthWindow(input.now);

  if (!Number.isSafeInteger(input.usedSessions) || input.usedSessions < 0) {
    throw new RangeError("usedSessions must be a non-negative safe integer");
  }

  if (
    !Number.isSafeInteger(input.requestedDurationMinutes) ||
    input.requestedDurationMinutes < 1
  ) {
    throw new RangeError("requestedDurationMinutes must be a positive safe integer");
  }

  const remaining = Math.max(0, limits.sessionsPerUtcMonth - input.usedSessions);
  if (input.requestedDurationMinutes > limits.maxDurationMinutes) {
    return { allowed: false, reason: "duration-limit", remaining, limits, window };
  }

  if (remaining === 0) {
    return {
      allowed: false,
      reason: "monthly-session-limit",
      remaining: 0,
      limits,
      window,
    };
  }

  return {
    allowed: true,
    remainingAfterReservation: remaining - 1,
    limits,
    window,
  };
}
