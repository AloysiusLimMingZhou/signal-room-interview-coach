export interface P1Config {
  stageName: string;
  allowedOrigin: string;
  globalMonthlyInterviewLimit: number;
  userMonthlyInterviewLimit: number;
  sessionDurationMinutes: number;
  geminiSecretArn?: string;
}

const STAGE_PATTERN = /^[a-z][a-z0-9-]{0,19}$/;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
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
  if ((stageName === "prod" || stageName === "production") && url.protocol !== "https:") {
    throw new Error("Production P1_ALLOWED_ORIGIN must use HTTPS.");
  }
  if (url.protocol === "http:" && !isLocalhost) {
    throw new Error("Plain HTTP origins are allowed only for localhost development.");
  }

  return url.origin;
}

export function resolveP1Config(
  context: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = process.env,
): P1Config {
  const stageName = String(context.stage ?? environment.DEPLOY_STAGE ?? "dev");
  if (!STAGE_PATTERN.test(stageName)) {
    throw new Error("stage must start with a letter and contain only lowercase letters, digits, or hyphens.");
  }

  const defaultOrigin = stageName === "prod" || stageName === "production"
    ? undefined
    : "http://localhost:3000";
  const rawOrigin = context.allowedOrigin ?? environment.P1_ALLOWED_ORIGIN ?? defaultOrigin;
  if (typeof rawOrigin !== "string" || rawOrigin.length === 0) {
    throw new Error("P1_ALLOWED_ORIGIN is required for production deployments.");
  }

  const geminiSecretArn = context.geminiSecretArn ?? environment.GEMINI_SECRET_ARN;
  if (geminiSecretArn !== undefined && typeof geminiSecretArn !== "string") {
    throw new Error("geminiSecretArn must be a string when provided.");
  }

  const globalMonthlyInterviewLimit = positiveInteger(
    String(context.globalMonthlyInterviewLimit ?? environment.GLOBAL_MONTHLY_INTERVIEW_LIMIT ?? ""),
    10,
    "GLOBAL_MONTHLY_INTERVIEW_LIMIT",
  );
  const userMonthlyInterviewLimit = positiveInteger(
    String(context.userMonthlyInterviewLimit ?? environment.USER_MONTHLY_INTERVIEW_LIMIT ?? ""),
    10,
    "USER_MONTHLY_INTERVIEW_LIMIT",
  );
  const sessionDurationMinutes = positiveInteger(
    String(context.sessionDurationMinutes ?? environment.SESSION_DURATION_MINUTES ?? ""),
    10,
    "SESSION_DURATION_MINUTES",
  );
  if (globalMonthlyInterviewLimit > 10) {
    throw new Error("GLOBAL_MONTHLY_INTERVIEW_LIMIT cannot exceed the indie pilot hard cap of 10.");
  }
  if (userMonthlyInterviewLimit > globalMonthlyInterviewLimit) {
    throw new Error("USER_MONTHLY_INTERVIEW_LIMIT cannot exceed the global limit.");
  }
  if (sessionDurationMinutes > 10) {
    throw new Error("SESSION_DURATION_MINUTES cannot exceed the indie pilot hard cap of 10.");
  }

  return {
    stageName,
    allowedOrigin: assertAllowedOrigin(rawOrigin, stageName),
    globalMonthlyInterviewLimit,
    userMonthlyInterviewLimit,
    sessionDurationMinutes,
    geminiSecretArn: geminiSecretArn || undefined,
  };
}
