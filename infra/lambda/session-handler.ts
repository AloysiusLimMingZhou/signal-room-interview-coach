import { createHash, randomUUID } from "node:crypto";
import { getUtcMonthWindow } from "../../src/lib/p1/quota";
import { quotaKeys, userAllowance } from "../lib/access-policy";
import {
  assertQuotaLikelyAvailable,
  getIdempotencyRecord,
  getSessionResponse,
  persistProvisionedResponse,
  persistSession,
  rollbackSessionReservation,
  type QuotaReservation,
  type SessionResponseRecord,
} from "./session-store";
import { allowanceLimitsFromEnvironment, voiceSessionMinutesFromEnvironment } from "./shared/allowances";
import { requiredEnvironment } from "./shared/aws-clients";
import {
  sessionCreationResponseSchema,
  sessionRequestSchema,
  type SessionRequest,
} from "./shared/contracts";
import {
  loadGeminiApiKey,
  provisionGeminiToken,
  resolvedGeminiLiveModel,
  type ProvisionedToken,
} from "./shared/gemini";
import {
  authenticatedRole,
  authenticatedUserId,
  errorResponse,
  idempotencyKey,
  jsonResponse,
  parseJsonRequest,
  SafeHttpError,
  type ApiGatewayV2Event,
  type ApiResponse,
} from "./shared/http";
import { baseLogMetadata, emitMetric, hashReference, writeSafeLog } from "./shared/logging";
import { historySortKey } from "./shared/table-keys";

const OPERATION = "session.create" as const;
const REQUEST_REPLAY_WINDOW_MS = 2 * 60_000;

function requestHash(request: SessionRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function descriptor(sessionId: string, token: ProvisionedToken, durationMinutes: number) {
  return sessionCreationResponseSchema.parse({
    sessionId,
    mode: "gemini" as const,
    provider: "gemini" as const,
    model: token.model,
    token: token.token,
    expiresAt: token.expiresAt,
    maxDurationMinutes: durationMinutes,
    persistence: "aws" as const,
    resume: {
      enabled: true,
      contextCompressionTriggerTokens: 25_000,
      slidingWindowTokens: 8_000,
    },
  });
}

function descriptorFromStoredResponse(
  response: SessionResponseRecord | undefined,
  expectedHash: string,
  expectedSessionId: string,
  now: Date,
) {
  if (
    response?.requestHash !== expectedHash ||
    response.sessionId !== expectedSessionId ||
    typeof response.token !== "string" ||
    typeof response.model !== "string" ||
    typeof response.tokenExpiresAt !== "string" ||
    typeof response.durationMinutes !== "number" ||
    Date.parse(response.tokenExpiresAt) <= now.getTime()
  ) return undefined;

  return descriptor(
    expectedSessionId,
    { token: response.token, model: response.model, expiresAt: response.tokenExpiresAt },
    response.durationMinutes,
  );
}

function pendingRequestError(): SafeHttpError {
  return new SafeHttpError(
    409,
    "session_request_pending",
    "The original session request is still completing.",
    { "Retry-After": "1" },
  );
}

function resultForError(error: unknown) {
  if (error instanceof SafeHttpError) {
    if (error.errorCode === "monthly_quota_exhausted") return "quota_exhausted" as const;
    if (error.statusCode === 401 || error.statusCode === 403) return "unauthorized" as const;
    return "invalid_request" as const;
  }
  return "internal_error" as const;
}

export async function handler(event: ApiGatewayV2Event): Promise<ApiResponse> {
  const startedAt = Date.now();
  let sessionRef: string | undefined;
  try {
    const tableName = requiredEnvironment("TABLE_NAME");
    const userId = authenticatedUserId(event);
    const role = authenticatedRole(event);
    if (role === "none") {
      throw new SafeHttpError(403, "account_not_enabled", "This account has not been enabled. Access is invite-only.");
    }
    const parsed = sessionRequestSchema.safeParse(parseJsonRequest(event, 8 * 1_024));
    if (!parsed.success) {
      throw new SafeHttpError(400, "invalid_request", "Choose a supported track and difficulty.");
    }

    const key = idempotencyKey(event);
    const hash = requestHash(parsed.data);
    if (parsed.data.durationMinutes > voiceSessionMinutesFromEnvironment()) {
      throw new SafeHttpError(400, "duration_limit", "The requested interview duration exceeds the pilot limit.");
    }
    const durationMinutes = parsed.data.durationMinutes;
    const limits = allowanceLimitsFromEnvironment();
    const now = new Date();
    const reservation: QuotaReservation = {
      keys: quotaKeys("voice", userId, getUtcMonthWindow(now).key),
      globalLimit: limits.voice.global,
      userLimit: userAllowance(role, "voice", limits),
    };
    const existing = await getIdempotencyRecord(tableName, userId, key);

    if (existing) {
      if (existing.requestHash !== hash || typeof existing.sessionId !== "string") {
        emitMetric("idempotency_conflict", 1, "Count");
        throw new SafeHttpError(409, "idempotency_conflict", "That idempotency key was already used for a different request.");
      }
      const createdAt = typeof existing.createdAt === "string" ? Date.parse(existing.createdAt) : Number.NaN;
      if (!Number.isFinite(createdAt) || now.getTime() - createdAt > REQUEST_REPLAY_WINDOW_MS) {
        throw new SafeHttpError(409, "session_request_expired", "Start a new interview session request.");
      }
      sessionRef = hashReference(existing.sessionId);
      const storedDescriptor = descriptorFromStoredResponse(
        await getSessionResponse(tableName, userId, key),
        hash,
        existing.sessionId,
        now,
      );
      if (!storedDescriptor) throw pendingRequestError();
      writeSafeLog({
        ...baseLogMetadata(),
        level: "INFO",
        operation: OPERATION,
        result: "idempotent_replay",
        requestId: event.requestContext.requestId,
        sessionRef,
        provider: "gemini",
        model: storedDescriptor.model,
        durationMs: Date.now() - startedAt,
      });
      return jsonResponse(200, storedDescriptor);
    }

    await assertQuotaLikelyAvailable(tableName, reservation, now);
    const sessionId = randomUUID();
    sessionRef = hashReference(sessionId);
    const model = resolvedGeminiLiveModel();
    const historySk = historySortKey(now.toISOString(), sessionId);

    try {
      await persistSession({
        tableName,
        sessionId,
        userId,
        role,
        key,
        hash,
        request: parsed.data,
        now,
        durationMinutes,
        model,
        reservation,
        historySk,
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;

      const racedRecord = await getIdempotencyRecord(tableName, userId, key);
      if (racedRecord?.requestHash === hash && typeof racedRecord.sessionId === "string") {
        sessionRef = hashReference(racedRecord.sessionId);
        const racedDescriptor = descriptorFromStoredResponse(
          await getSessionResponse(tableName, userId, key),
          hash,
          racedRecord.sessionId,
          now,
        );
        if (racedDescriptor) return jsonResponse(200, racedDescriptor);
        throw pendingRequestError();
      }
      await assertQuotaLikelyAvailable(tableName, reservation, now);
      emitMetric("idempotency_conflict", 1, "Count");
      throw new SafeHttpError(409, "idempotency_conflict", "The request conflicted with another session start.");
    }

    let token: ProvisionedToken;
    try {
      const apiKey = await loadGeminiApiKey();
      token = await provisionGeminiToken(apiKey, parsed.data, now, durationMinutes + 2);
      await persistProvisionedResponse({ tableName, sessionId, userId, key, hash, token, durationMinutes, now });
    } catch (error) {
      try {
        await rollbackSessionReservation({ tableName, sessionId, userId, key, reservation, historySk });
      } catch {
        // A failed compensation leaves the conservative quota reservation in place.
      }
      throw error;
    }

    const durationMs = Date.now() - startedAt;
    emitMetric("session_setup_ms", durationMs, "Milliseconds");
    writeSafeLog({
      ...baseLogMetadata(),
      level: "INFO",
      operation: OPERATION,
      result: "success",
      requestId: event.requestContext.requestId,
      sessionRef,
      provider: "gemini",
      model: token.model,
      durationMs,
    });
    return jsonResponse(201, descriptor(sessionId, token, durationMinutes));
  } catch (error) {
    const isProviderError = error instanceof Error && error.message.startsWith("Gemini");
    const safeError = isProviderError
      ? new SafeHttpError(503, "provider_unavailable", "Gemini Live could not be provisioned. Retry shortly.")
      : error;
    const isServerFailure = !(safeError instanceof SafeHttpError) || safeError.statusCode >= 500;
    if (isServerFailure) emitMetric("session_setup_failed", 1, "Count");
    writeSafeLog({
      ...baseLogMetadata(),
      level: isServerFailure ? "ERROR" : "WARN",
      operation: OPERATION,
      result: isProviderError ? "provider_unavailable" : resultForError(safeError),
      requestId: event.requestContext.requestId,
      sessionRef,
      durationMs: Date.now() - startedAt,
    });
    return errorResponse(safeError);
  }
}
