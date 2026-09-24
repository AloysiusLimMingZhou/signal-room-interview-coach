/** Shared synth/runtime caps. Increasing one requires an architecture decision. */
export interface TextLimits { sessionMinutes: number; maxTurns: number; maxTurnChars: number }
export const TEXT_HARD_LIMITS: Readonly<TextLimits> = Object.freeze({ sessionMinutes: 30, maxTurns: 40, maxTurnChars: 4_000 });
const names: Record<keyof TextLimits, string> = {
  sessionMinutes: "TEXT_SESSION_MINUTES", maxTurns: "TEXT_MAX_TURNS", maxTurnChars: "TEXT_MAX_TURN_CHARS",
};
export function validateTextLimits(limits: TextLimits): TextLimits {
  for (const field of Object.keys(names) as Array<keyof TextLimits>) {
    if (!Number.isSafeInteger(limits[field]) || limits[field] < 1 || limits[field] > TEXT_HARD_LIMITS[field]) {
      throw new Error(`${names[field]} must be a positive integer at or below its hard cap of ${TEXT_HARD_LIMITS[field]}.`);
    }
  }
  return limits;
}
export function readTextLimits(read: (name: string, fallback: number) => number): TextLimits {
  return validateTextLimits({
    sessionMinutes: read(names.sessionMinutes, TEXT_HARD_LIMITS.sessionMinutes),
    maxTurns: read(names.maxTurns, TEXT_HARD_LIMITS.maxTurns),
    maxTurnChars: read(names.maxTurnChars, TEXT_HARD_LIMITS.maxTurnChars),
  });
}
export function textLimitEnvironment(limits: TextLimits): Record<string, string> {
  validateTextLimits(limits);
  return Object.fromEntries((Object.keys(names) as Array<keyof TextLimits>).map((key) => [names[key], String(limits[key])]));
}
