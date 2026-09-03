export interface ApiGatewayV2Event {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  isBase64Encoded?: boolean;
  requestContext: {
    requestId: string;
    authorizer?: {
      jwt?: {
        claims?: Record<string, unknown>;
      };
    };
  };
}

export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const USER_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export class SafeHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    public readonly safeMessage: string,
    public readonly responseHeaders: Record<string, string> = {},
  ) {
    super(errorCode);
    this.name = "SafeHttpError";
  }
}

export function jsonResponse(
  statusCode: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): ApiResponse {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
    body: JSON.stringify(value),
  };
}

export function errorResponse(error: unknown): ApiResponse {
  if (error instanceof SafeHttpError) {
    return jsonResponse(
      error.statusCode,
      { error: error.errorCode, message: error.safeMessage },
      error.responseHeaders,
    );
  }

  return jsonResponse(500, {
    error: "internal_error",
    message: "The request could not be completed. Retry shortly.",
  });
}

export function parseJsonRequest(event: ApiGatewayV2Event, maxBytes = 96 * 1024): unknown {
  const contentType = event.headers?.["content-type"] ?? event.headers?.["Content-Type"];
  if (!contentType?.toLowerCase().startsWith("application/json")) {
    throw new SafeHttpError(415, "unsupported_media_type", "Send the request as application/json.");
  }

  if (!event.body) {
    throw new SafeHttpError(400, "invalid_request", "A JSON request body is required.");
  }

  const bytes = event.isBase64Encoded
    ? Buffer.from(event.body, "base64")
    : Buffer.from(event.body, "utf8");
  if (bytes.byteLength > maxBytes) {
    throw new SafeHttpError(413, "request_too_large", "The request body exceeds the allowed size.");
  }

  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new SafeHttpError(400, "invalid_json", "The request body must be valid JSON.");
  }
}

export function authenticatedUserId(event: ApiGatewayV2Event): string {
  const value = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof value !== "string" || !USER_ID_PATTERN.test(value)) {
    throw new SafeHttpError(401, "unauthorized", "A valid signed-in session is required.");
  }
  return value;
}

export function idempotencyKey(event: ApiGatewayV2Event): string {
  const supplied = event.headers?.["idempotency-key"] ?? event.headers?.["Idempotency-Key"];
  const value = supplied ?? `request:${event.requestContext.requestId}`;
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new SafeHttpError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must be 8–128 URL-safe characters.",
    );
  }
  return value;
}

export function secondsUntilNextUtcMonth(now = new Date()): number {
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((nextMonth - now.getTime()) / 1_000));
}
