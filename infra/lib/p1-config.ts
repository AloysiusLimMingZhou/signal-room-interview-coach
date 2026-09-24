import { HARD_LIMITS, readAllowanceLimits, type AllowanceLimits } from "./access-policy";
import { readTextLimits, type TextLimits } from "./text-limits";

export interface P1Config {
  stageName: string;
  allowedOrigin: string;
  allowances: AllowanceLimits;
  voiceSessionMinutes: number;
  textLimits: TextLimits;
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
  environment: Partial<NodeJS.ProcessEnv> = process.env,
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
    textLimits: readTextLimits((name, fallback) => positiveInteger(environment[name], fallback, name)),
    alertEmail: resolveAlertEmail(context.alertEmail ?? environment.ALERT_EMAIL, stageName),
  };
}
