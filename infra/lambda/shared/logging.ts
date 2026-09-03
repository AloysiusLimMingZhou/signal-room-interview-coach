import { createHash } from "node:crypto";
import { z } from "zod";
import {
  applicationMetricSchema,
  normalizeGeminiModelDimension,
  serializeStructuredLog,
  type MetricName,
} from "../../../src/lib/p1";

const safeLogSchema = z.object({
  level: z.enum(["INFO", "WARN", "ERROR"]),
  operation: z.enum(["session.create", "event.append", "grading.run"]),
  result: z.enum([
    "success",
    "invalid_request",
    "unauthorized",
    "quota_exhausted",
    "idempotent_replay",
    "idempotency_conflict",
    "not_found",
    "provider_unavailable",
    "schema_failure",
    "internal_error",
  ]),
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  traceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9=;._:-]+$/).optional(),
  sessionRef: z.string().regex(/^sr_[a-f0-9]{16}$/).optional(),
  provider: z.literal("gemini").optional(),
  model: z.string().min(1).max(128).regex(/^[A-Za-z0-9._/-]+$/).optional(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  itemCount: z.number().int().nonnegative().max(1_000_000).optional(),
}).strict();

export type SafeLogMetadata = z.infer<typeof safeLogSchema>;

function environment(): "development" | "staging" | "production" {
  const stage = process.env.ENVIRONMENT;
  if (stage === "prod" || stage === "production") return "production";
  if (stage === "stage" || stage === "staging") return "staging";
  return "development";
}

export function validateSafeLogMetadata(value: unknown): SafeLogMetadata {
  return safeLogSchema.parse(value);
}

export function writeSafeLog(value: SafeLogMetadata): void {
  const parsed = validateSafeLogMetadata(value);
  const result = parsed.result === "success" || parsed.result === "idempotent_replay"
    ? "success"
    : parsed.result === "internal_error" || parsed.result === "provider_unavailable" || parsed.result === "schema_failure"
      ? "failure"
      : "rejected";

  console.log(serializeStructuredLog({
    level: parsed.level.toLowerCase() as "info" | "warn" | "error",
    operation: parsed.operation,
    result,
    environment: environment(),
    requestId: parsed.requestId,
    traceId: parsed.traceId,
    sessionRef: parsed.sessionRef,
    durationMs: parsed.durationMs,
    metadata: {
      outcome: parsed.result,
      ...(parsed.provider ? { provider: parsed.provider } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.itemCount === undefined ? {} : { itemCount: parsed.itemCount }),
    },
  }));
}

export function hashReference(value: string): string {
  return `sr_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function currentTraceId(): string | undefined {
  const raw = process.env._X_AMZN_TRACE_ID;
  if (!raw || raw.length > 256) return undefined;
  const root = raw.split(";").find((part) => part.startsWith("Root="));
  return root && /^[A-Za-z0-9=._:-]+$/.test(root) ? root : undefined;
}

export function baseLogMetadata(): Pick<SafeLogMetadata, "traceId"> {
  return { traceId: currentTraceId() };
}

export function emitMetric(
  name: MetricName,
  value: number,
  unit: "Milliseconds" | "Count" | "None",
  model?: string,
): void {
  const dimensions = {
    environment: environment(),
    provider: name.startsWith("gemini_") ? "gemini" as const : "application" as const,
    ...(model ? { model: normalizeGeminiModelDimension(model) } : {}),
  };
  const metric = applicationMetricSchema.parse({ name, value, unit, dimensions });
  const namespace = process.env.LOG_NAMESPACE ?? "SignalRoom/P1";
  const dimensionNames = Object.keys(metric.dimensions);

  // Lambda JSON logging wraps console output. EMF requires `_aws` at the log
  // event root, so write the metric document directly to stdout.
  process.stdout.write(`${JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: namespace,
        Dimensions: [dimensionNames.map((key) => key[0].toUpperCase() + key.slice(1))],
        Metrics: [{ Name: metric.name, Unit: metric.unit }],
      }],
    },
    ...Object.fromEntries(
      Object.entries(metric.dimensions).map(([key, dimensionValue]) => [
        key[0].toUpperCase() + key.slice(1),
        dimensionValue,
      ]),
    ),
    [metric.name]: metric.value,
  })}\n`);
}
