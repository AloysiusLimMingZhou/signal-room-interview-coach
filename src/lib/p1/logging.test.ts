import {
  createStructuredLog,
  sanitizeLogMetadata,
  serializeStructuredLog,
} from "./logging";
import { applicationMetricSchema, normalizeGeminiModelDimension } from "./metrics";

describe("privacy-safe structured logging", () => {
  it("redacts interview artifacts, identity, authorization, and credentials recursively", () => {
    const serialized = serializeStructuredLog({
      level: "warn",
      operation: "append-events",
      result: "rejected",
      environment: "production",
      sessionRef: "sr_12f55b83",
      now: new Date("2026-09-01T00:00:00.000Z"),
      metadata: {
        transcript: "candidate private answer",
        codePatch: "- insecure\n+ secure",
        nested: {
          canvasNodes: ["database"],
          audio: "base64 data",
          resumeText: "name and employment history",
          authorization: "Bearer live-secret-token",
          apiKey: "AIzaThisMustNeverAppearInLogs12345",
          sessionId: "raw-session-id",
        },
      },
    });

    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("candidate private answer");
    expect(serialized).not.toContain("insecure");
    expect(serialized).not.toContain("database");
    expect(serialized).not.toContain("employment history");
    expect(serialized).not.toContain("live-secret-token");
    expect(serialized).not.toContain("raw-session-id");
  });

  it("redacts secret-looking values even when the key is otherwise safe", () => {
    const output = sanitizeLogMetadata({
      reason: "upstream said Authorization: Bearer abc.def.ghi",
      details: "api_key=supersecretvalue",
      statusCode: 503,
      errorCode: "provider_unavailable",
    });

    expect(JSON.stringify(output)).not.toContain("supersecretvalue");
    expect(JSON.stringify(output)).not.toContain("abc.def.ghi");
    expect(output.statusCode).toBe(503);
    expect(output.errorCode).toBe("provider_unavailable");
  });

  it("always returns JSON-safe bounded metadata for cycles and unsupported values", () => {
    const cyclic: Record<string, unknown> = { count: Number.POSITIVE_INFINITY, bigint: 12n };
    cyclic.self = cyclic;
    cyclic.callback = () => undefined;
    cyclic.items = Array.from({ length: 25 }, (_, index) => index);

    const output = sanitizeLogMetadata(cyclic);

    expect(() => JSON.stringify(output)).not.toThrow();
    expect(output).toMatchObject({
      count: "[NON_FINITE_NUMBER]",
      bigint: "12",
      self: "[CIRCULAR]",
      callback: "[UNSUPPORTED_VALUE]",
    });
    expect(output.items).toHaveLength(21);
    expect(() => sanitizeLogMetadata("not an object")).toThrow(TypeError);
  });

  it("creates a bounded record without accepting raw metadata fields at the top level", () => {
    const record = createStructuredLog({
      level: "info",
      operation: "create-session",
      result: "success",
      environment: "staging",
      durationMs: 42,
      metadata: { provider: "gemini" },
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(record).toMatchObject({
      timestamp: "2026-09-01T00:00:00.000Z",
      operation: "create-session",
      durationMs: 42,
      metadata: { provider: "gemini" },
    });

    expect(
      createStructuredLog({
        level: "info",
        operation: "create-session",
        result: "success",
        environment: "production",
        sessionRef: "123e4567-e89b-42d3-a456-426614174000",
      }).sessionRef,
    ).toBe("[REDACTED]");
  });
});

describe("low-cardinality metrics", () => {
  it("accepts only allowlisted dimensions and model buckets", () => {
    expect(
      applicationMetricSchema.safeParse({
        name: "session_setup_ms",
        value: 250,
        unit: "Milliseconds",
        dimensions: { environment: "production", provider: "gemini", model: "other" },
      }).success,
    ).toBe(true);

    expect(
      applicationMetricSchema.safeParse({
        name: "session_setup_ms",
        value: 250,
        unit: "Milliseconds",
        dimensions: { environment: "production", sessionId: "high-cardinality" },
      }).success,
    ).toBe(false);
    expect(normalizeGeminiModelDimension("experimental-model-per-request")).toBe("other");
    expect(
      applicationMetricSchema.safeParse({
        name: "session_setup_ms",
        value: 1,
        unit: "Count",
        dimensions: { environment: "production" },
      }).success,
    ).toBe(false);
  });
});
