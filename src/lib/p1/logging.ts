export type JsonLogValue =
  | null
  | boolean
  | number
  | string
  | JsonLogValue[]
  | { [key: string]: JsonLogValue };

export type JsonLogMetadata = Record<string, JsonLogValue>;

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 50;
const MAX_STRING_LENGTH = 256;
const SAFE_SESSION_REFERENCE = /^sr_[a-f0-9]{8,64}$/;

const SAFE_CODE_KEYS = new Set(["errorcode", "exitcode", "statuscode", "resultcode"]);
const SENSITIVE_KEY_FRAGMENT =
  /authorization|cookie|credential|password|passwd|secret|token|apikey|privatekey|clientsecret|sessionid|userid|email|ipaddress|sourceip|transcript|canvas|audio|recording|resume|cvtext|sourcecode|codepatch|codecontent|codeedit|requestbody|responsebody|payload|events/;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s,;&]+/gi,
];

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveLogKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (SAFE_CODE_KEYS.has(normalized)) {
    return false;
  }

  return normalized === "code" || SENSITIVE_KEY_FRAGMENT.test(normalized);
}

function redactString(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }

  if (redacted.length > MAX_STRING_LENGTH) {
    return `${redacted.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]`;
  }

  return redacted;
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): JsonLogValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? redactString(value) : value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : "[NON_FINITE_NUMBER]";
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return "[UNSUPPORTED_VALUE]";
  }

  if (depth >= MAX_DEPTH) {
    return "[MAX_DEPTH]";
  }

  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[INVALID_DATE]" : value.toISOString();
  }

  if (Array.isArray(value)) {
    const output = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      output.push(`[${value.length - MAX_ARRAY_ITEMS} ITEMS OMITTED]`);
    }
    return output;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return "[UNSUPPORTED_OBJECT]";
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const output: Record<string, JsonLogValue> = {};
  for (const [key, nestedValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
    output[key.slice(0, 80)] = isSensitiveLogKey(key)
      ? REDACTED
      : sanitizeValue(nestedValue, depth + 1, seen);
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    output._omittedKeyCount = entries.length - MAX_OBJECT_KEYS;
  }
  return output;
}

export function sanitizeLogMetadata(metadata: unknown): JsonLogMetadata {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("Log metadata must be an object");
  }

  return sanitizeValue(metadata, 0, new WeakSet()) as JsonLogMetadata;
}

export interface StructuredLogInput {
  level: "debug" | "info" | "warn" | "error";
  operation: string;
  result: "success" | "rejected" | "failure";
  environment: "development" | "staging" | "production";
  requestId?: string;
  traceId?: string;
  sessionRef?: string;
  durationMs?: number;
  metadata?: unknown;
  now?: Date;
}

export function createStructuredLog(input: StructuredLogInput): JsonLogMetadata {
  const now = input.now ?? new Date();
  const record = {
    timestamp: now.toISOString(),
    level: input.level,
    operation: redactString(input.operation),
    result: input.result,
    environment: input.environment,
    ...(input.requestId ? { requestId: redactString(input.requestId) } : {}),
    ...(input.traceId ? { traceId: redactString(input.traceId) } : {}),
    ...(input.sessionRef
      ? { sessionRef: SAFE_SESSION_REFERENCE.test(input.sessionRef) ? input.sessionRef : REDACTED }
      : {}),
    ...(input.durationMs === undefined
      ? {}
      : { durationMs: Number.isFinite(input.durationMs) ? input.durationMs : "[NON_FINITE_NUMBER]" }),
    ...(input.metadata === undefined ? {} : { metadata: sanitizeLogMetadata(input.metadata) }),
  };

  return sanitizeLogMetadata(record);
}

export function serializeStructuredLog(input: StructuredLogInput): string {
  return JSON.stringify(createStructuredLog(input));
}
