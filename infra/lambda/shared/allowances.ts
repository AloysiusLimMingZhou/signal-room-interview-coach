import { HARD_LIMITS, readAllowanceLimits, type AllowanceLimits } from "../../lib/access-policy";
import { positiveIntegerEnvironment } from "./aws-clients";
import { readTextLimits, type TextLimits } from "../../lib/text-limits";

export function textLimitsFromEnvironment(): TextLimits {
  return readTextLimits(positiveIntegerEnvironment);
}

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
