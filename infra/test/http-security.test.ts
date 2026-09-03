/** @jest-environment node */
import {
  authenticatedUserId,
  errorResponse,
  idempotencyKey,
  parseJsonRequest,
  SafeHttpError,
  secondsUntilNextUtcMonth,
  type ApiGatewayV2Event,
} from "../lambda/shared/http";
import { emitMetric, validateSafeLogMetadata } from "../lambda/shared/logging";

function event(overrides: Partial<ApiGatewayV2Event> = {}): ApiGatewayV2Event {
  return {
    body: JSON.stringify({ ok: true }),
    headers: { "content-type": "application/json", "idempotency-key": "request-1234" },
    requestContext: {
      requestId: "request-1234",
      authorizer: { jwt: { claims: { sub: "user-1234" } } },
    },
    ...overrides,
  };
}

describe("P1 HTTP and log safety", () => {
  it("requires signed identity and a bounded idempotency key", () => {
    expect(authenticatedUserId(event())).toBe("user-1234");
    expect(idempotencyKey(event())).toBe("request-1234");
    expect(() => authenticatedUserId(event({ requestContext: { requestId: "request-1234" } }))).toThrow(
      SafeHttpError,
    );
    try {
      idempotencyKey(event({ headers: { "idempotency-key": "bad key" } }));
      throw new Error("Expected an invalid idempotency key to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 400,
        errorCode: "invalid_idempotency_key",
        safeMessage: expect.stringMatching(/Idempotency-Key/),
      });
    }
  });

  it("accepts only bounded JSON and emits generic no-store errors", () => {
    expect(parseJsonRequest(event())).toEqual({ ok: true });
    try {
      parseJsonRequest(event({ headers: { "content-type": "text/plain" } }));
      throw new Error("Expected a non-JSON request to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 415,
        errorCode: "unsupported_media_type",
        safeMessage: expect.stringMatching(/application\/json/),
      });
    }
    try {
      parseJsonRequest(event({ body: "x".repeat(100) }), 10);
      throw new Error("Expected an oversized request to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 413,
        errorCode: "request_too_large",
        safeMessage: expect.stringMatching(/allowed size/),
      });
    }

    const response = errorResponse(new Error("AIza-secret-must-never-escape"));
    expect(response.statusCode).toBe(500);
    expect(response.headers["Cache-Control"]).toContain("no-store");
    expect(response.body).not.toContain("AIza");
  });

  it("does not allow content-bearing fields into Lambda logs", () => {
    expect(() => validateSafeLogMetadata({
      level: "INFO",
      operation: "event.append",
      result: "success",
      transcript: "private candidate answer",
    })).toThrow();
    expect(validateSafeLogMetadata({
      level: "INFO",
      operation: "event.append",
      result: "success",
      sessionRef: `sr_${"a".repeat(16)}`,
      itemCount: 2,
    })).toMatchObject({ result: "success", sessionRef: `sr_${"a".repeat(16)}`, itemCount: 2 });
  });

  it("calculates retry-after at the next UTC-month boundary", () => {
    expect(secondsUntilNextUtcMonth(new Date("2026-01-31T23:59:30.000Z"))).toBe(30);
  });

  it("writes EMF with _aws at the stdout document root", () => {
    let emitted = "";
    const stdout = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      emitted += String(chunk);
      return true;
    });
    try {
      emitMetric("session_setup_ms", 120, "Milliseconds");
    } finally {
      stdout.mockRestore();
    }

    expect(JSON.parse(emitted)).toMatchObject({
      _aws: {
        CloudWatchMetrics: [{
          Namespace: "SignalRoom/P1",
          Metrics: [{ Name: "session_setup_ms", Unit: "Milliseconds" }],
        }],
      },
      session_setup_ms: 120,
    });
  });
});
