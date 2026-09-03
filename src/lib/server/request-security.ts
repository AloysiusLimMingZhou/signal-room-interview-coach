import "server-only";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export class RequestValidationError extends Error {
  constructor(message = "Invalid request") {
    super(message);
    this.name = "RequestValidationError";
  }
}
export async function readJsonBody(
  request: Request,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      throw new RequestValidationError("Request body is too large");
    }
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new RequestValidationError("Request body is too large");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestValidationError("Request body must be valid JSON");
  }
}

function configuredAppOrigin(): string | undefined {
  const configured = process.env.APP_ORIGIN?.trim();
  if (!configured) return undefined;

  const parsed = new URL(configured);
  const isLocalDevelopment =
    process.env.NODE_ENV !== "production" &&
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(parsed.hostname);

  if (parsed.protocol !== "https:" && !isLocalDevelopment) {
    throw new Error("APP_ORIGIN must use HTTPS outside local development");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("APP_ORIGIN must contain only an origin");
  }

  return parsed.origin;
}

export function resolveAppOrigin(requestUrl: string): string {
  const configured = configuredAppOrigin();
  if (configured) return configured;

  if (process.env.NODE_ENV === "production" && process.env.P1_API_URL) {
    throw new Error("APP_ORIGIN is required when the P1 API is enabled in production");
  }

  return new URL(requestUrl).origin;
}

export function hasTrustedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin === resolveAppOrigin(request.url);
  } catch {
    return false;
  }
}
