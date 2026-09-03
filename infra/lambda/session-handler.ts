import { createHash, randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient, positiveIntegerEnvironment, requiredEnvironment } from "./shared/aws-clients";
import {
  sessionCreationResponseSchema,
  sessionRequestSchema,
  type SessionRequest,
} from "./shared/contracts";
import { getUtcMonthWindow } from "../../src/lib/p1/quota";
import {
  loadGeminiApiKey,
  provisionGeminiToken,
  resolvedGeminiLiveModel,
  type ProvisionedToken,
} from "./shared/gemini";
import {
  authenticatedUserId,
  errorResponse,
  idempotencyKey,
  jsonResponse,
  parseJsonRequest,
  SafeHttpError,
  secondsUntilNextUtcMonth,
  type ApiGatewayV2Event,
  type ApiResponse,
} from "./shared/http";
import { baseLogMetadata, emitMetric, hashReference, writeSafeLog } from "./shared/logging";

interface IdempotencyRecord {
  createdAt?: unknown;
  requestHash?: unknown;
  sessionId?: unknown;
}

interface QuotaRecord {
  used?: unknown;
}

interface SessionResponseRecord {
  requestHash?: unknown;
  sessionId?: unknown;
  token?: unknown;
  model?: unknown;
  tokenExpiresAt?: unknown;
  durationMinutes?: unknown;
}

const OPERATION = "session.create" as const;

function quotaExpiry(now: Date): number {
  return Math.floor(Date.UTC(now.getUTCFullYear() + 2, now.getUTCMonth() + 1, 1) / 1_000);
}

function requestHash(request: SessionRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function idempotencyKeys(userId: string, key: string): { PK: string; SK: string } {
  return { PK: `USER#${userId}`, SK: `SESSION_REQUEST#${key}` };
}

function responseKeys(userId: string, key: string): { PK: string; SK: string } {
  return { PK: `USER#${userId}`, SK: `SESSION_RESPONSE#${key}` };
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

async function getIdempotencyRecord(
  tableName: string,
  userId: string,
  key: string,
): Promise<IdempotencyRecord | undefined> {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: idempotencyKeys(userId, key),
    ConsistentRead: true,
    ProjectionExpression: "createdAt, requestHash, sessionId",
  }));
  return response.Item as IdempotencyRecord | undefined;
}

async function getSessionResponse(
  tableName: string,
  userId: string,
  key: string,
): Promise<SessionResponseRecord | undefined> {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: responseKeys(userId, key),
    ConsistentRead: true,
    ProjectionExpression: "requestHash, sessionId, #token, model, tokenExpiresAt, durationMinutes",
    ExpressionAttributeNames: { "#token": "token" },
  }));
  return response.Item as SessionResponseRecord | undefined;
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

async function quotaUsed(tableName: string, PK: string, SK: string): Promise<number> {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: { PK, SK },
    ConsistentRead: true,
    ProjectionExpression: "used",
  }));
  const item = response.Item as QuotaRecord | undefined;
  return typeof item?.used === "number" && Number.isSafeInteger(item.used) ? item.used : 0;
}

async function assertQuotaLikelyAvailable(
  tableName: string,
  userId: string,
  monthKey: string,
  globalLimit: number,
  userLimit: number,
  now: Date,
): Promise<void> {
  const [globalUsed, userUsed] = await Promise.all([
    quotaUsed(tableName, "QUOTA#GLOBAL", monthKey),
    quotaUsed(tableName, `QUOTA#USER#${userId}`, monthKey),
  ]);
  if (globalUsed >= globalLimit || userUsed >= userLimit) {
    throw new SafeHttpError(
      429,
      "monthly_quota_exhausted",
      "The monthly interview limit has been reached.",
      { "Retry-After": String(secondsUntilNextUtcMonth(now)) },
    );
  }
}

async function persistSession(input: {
  tableName: string;
  sessionId: string;
  userId: string;
  key: string;
  hash: string;
  request: SessionRequest;
  now: Date;
  durationMinutes: number;
  globalLimit: number;
  userLimit: number;
  model: string;
}): Promise<void> {
  const monthKey = `MONTH#${getUtcMonthWindow(input.now).key}`;
  const expiresAt = quotaExpiry(input.now);
  const createdAt = input.now.toISOString();
  const sessionEndsAt = new Date(input.now.getTime() + input.durationMinutes * 60_000).toISOString();

  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: input.tableName,
          Key: { PK: "QUOTA#GLOBAL", SK: monthKey },
          UpdateExpression: "SET #used = if_not_exists(#used, :zero) + :one, #limit = :limit, updatedAt = :now, expiresAt = :expiresAt",
          ConditionExpression: "attribute_not_exists(#used) OR #used < :limit",
          ExpressionAttributeNames: { "#used": "used", "#limit": "limit" },
          ExpressionAttributeValues: {
            ":zero": 0,
            ":one": 1,
            ":limit": input.globalLimit,
            ":now": createdAt,
            ":expiresAt": expiresAt,
          },
        },
      },
      {
        Update: {
          TableName: input.tableName,
          Key: { PK: `QUOTA#USER#${input.userId}`, SK: monthKey },
          UpdateExpression: "SET #used = if_not_exists(#used, :zero) + :one, #limit = :limit, updatedAt = :now, expiresAt = :expiresAt",
          ConditionExpression: "attribute_not_exists(#used) OR #used < :limit",
          ExpressionAttributeNames: { "#used": "used", "#limit": "limit" },
          ExpressionAttributeValues: {
            ":zero": 0,
            ":one": 1,
            ":limit": input.userLimit,
            ":now": createdAt,
            ":expiresAt": expiresAt,
          },
        },
      },
      {
        Put: {
          TableName: input.tableName,
          Item: {
            ...idempotencyKeys(input.userId, input.key),
            entityType: "SessionRequest",
            requestHash: input.hash,
            sessionId: input.sessionId,
            createdAt,
            expiresAt,
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      },
      {
        Put: {
          TableName: input.tableName,
          Item: {
            PK: `SESSION#${input.sessionId}`,
            SK: "META",
            entityType: "InterviewSession",
            sessionId: input.sessionId,
            userId: input.userId,
            track: input.request.track,
            difficulty: input.request.difficulty,
            provider: "gemini",
            model: input.model,
            durationMinutes: input.durationMinutes,
            status: "provisioning",
            lastSequence: 0,
            eventCount: 0,
            createdAt,
            sessionEndsAt,
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      },
    ],
  }));
}

async function persistProvisionedResponse(input: {
  tableName: string;
  sessionId: string;
  userId: string;
  key: string;
  hash: string;
  token: ProvisionedToken;
  durationMinutes: number;
  now: Date;
}): Promise<void> {
  const tokenExpiresAtEpoch = Math.floor(Date.parse(input.token.expiresAt) / 1_000) + 60;
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: input.tableName,
          Key: { PK: `SESSION#${input.sessionId}`, SK: "META" },
          UpdateExpression: "SET #status = :ready, credentialExpiresAt = :tokenExpiresAt",
          ConditionExpression: "userId = :userId AND #status = :provisioning",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":userId": input.userId,
            ":provisioning": "provisioning",
            ":ready": "created",
            ":tokenExpiresAt": input.token.expiresAt,
          },
        },
      },
      {
        Put: {
          TableName: input.tableName,
          Item: {
            ...responseKeys(input.userId, input.key),
            entityType: "SessionResponse",
            requestHash: input.hash,
            sessionId: input.sessionId,
            token: input.token.token,
            model: input.token.model,
            tokenExpiresAt: input.token.expiresAt,
            durationMinutes: input.durationMinutes,
            createdAt: input.now.toISOString(),
            expiresAt: tokenExpiresAtEpoch,
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      },
    ],
  }));
}

async function rollbackSessionReservation(input: {
  tableName: string;
  sessionId: string;
  userId: string;
  key: string;
  monthKey: string;
}): Promise<void> {
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: input.tableName,
          Key: { PK: "QUOTA#GLOBAL", SK: input.monthKey },
          UpdateExpression: "SET #used = #used - :one",
          ConditionExpression: "#used >= :one",
          ExpressionAttributeNames: { "#used": "used" },
          ExpressionAttributeValues: { ":one": 1 },
        },
      },
      {
        Update: {
          TableName: input.tableName,
          Key: { PK: `QUOTA#USER#${input.userId}`, SK: input.monthKey },
          UpdateExpression: "SET #used = #used - :one",
          ConditionExpression: "#used >= :one",
          ExpressionAttributeNames: { "#used": "used" },
          ExpressionAttributeValues: { ":one": 1 },
        },
      },
      {
        Delete: {
          TableName: input.tableName,
          Key: idempotencyKeys(input.userId, input.key),
          ConditionExpression: "sessionId = :sessionId",
          ExpressionAttributeValues: { ":sessionId": input.sessionId },
        },
      },
      {
        Delete: {
          TableName: input.tableName,
          Key: { PK: `SESSION#${input.sessionId}`, SK: "META" },
          ConditionExpression: "userId = :userId AND #status = :provisioning",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":userId": input.userId,
            ":provisioning": "provisioning",
          },
        },
      },
    ],
  }));
}

function resultForError(error: unknown) {
  if (error instanceof SafeHttpError) {
    if (error.errorCode === "monthly_quota_exhausted") return "quota_exhausted" as const;
    if (error.statusCode === 401) return "unauthorized" as const;
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
    const parsed = sessionRequestSchema.safeParse(parseJsonRequest(event, 8 * 1_024));
    if (!parsed.success) {
      throw new SafeHttpError(400, "invalid_request", "Choose a supported track and difficulty.");
    }

    const key = idempotencyKey(event);
    const hash = requestHash(parsed.data);
    const configuredDurationMinutes = positiveIntegerEnvironment("SESSION_DURATION_MINUTES", 10);
    if (parsed.data.durationMinutes > configuredDurationMinutes) {
      throw new SafeHttpError(400, "duration_limit", "The requested interview duration exceeds the pilot limit.");
    }
    const durationMinutes = parsed.data.durationMinutes;
    const globalLimit = positiveIntegerEnvironment("GLOBAL_MONTHLY_INTERVIEW_LIMIT", 10);
    const userLimit = positiveIntegerEnvironment("USER_MONTHLY_INTERVIEW_LIMIT", 10);
    const now = new Date();
    const existing = await getIdempotencyRecord(tableName, userId, key);

    if (existing) {
      if (existing.requestHash !== hash || typeof existing.sessionId !== "string") {
        emitMetric("idempotency_conflict", 1, "Count");
        throw new SafeHttpError(
          409,
          "idempotency_conflict",
          "That idempotency key was already used for a different request.",
        );
      }
      const createdAt = typeof existing.createdAt === "string" ? Date.parse(existing.createdAt) : Number.NaN;
      if (!Number.isFinite(createdAt) || now.getTime() - createdAt > 2 * 60_000) {
        throw new SafeHttpError(409, "session_request_expired", "Start a new interview session request.");
      }
      sessionRef = hashReference(existing.sessionId);
      const storedDescriptor = descriptorFromStoredResponse(
        await getSessionResponse(tableName, userId, key),
        hash,
        existing.sessionId,
        now,
      );
      if (!storedDescriptor) {
        throw new SafeHttpError(
          409,
          "session_request_pending",
          "The original session request is still completing.",
          { "Retry-After": "1" },
        );
      }
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

    const monthKey = `MONTH#${getUtcMonthWindow(now).key}`;
    await assertQuotaLikelyAvailable(tableName, userId, monthKey, globalLimit, userLimit, now);
    const sessionId = randomUUID();
    sessionRef = hashReference(sessionId);
    const model = resolvedGeminiLiveModel();

    try {
      await persistSession({
        tableName,
        sessionId,
        userId,
        key,
        hash,
        request: parsed.data,
        now,
        durationMinutes,
        globalLimit,
        userLimit,
        model,
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
        throw new SafeHttpError(
          409,
          "session_request_pending",
          "The original session request is still completing.",
          { "Retry-After": "1" },
        );
      }
      await assertQuotaLikelyAvailable(tableName, userId, monthKey, globalLimit, userLimit, now);
      emitMetric("idempotency_conflict", 1, "Count");
      throw new SafeHttpError(409, "idempotency_conflict", "The request conflicted with another session start.");
    }

    let token: ProvisionedToken;
    try {
      const apiKey = await loadGeminiApiKey();
      token = await provisionGeminiToken(apiKey, parsed.data, now, durationMinutes + 2);
      await persistProvisionedResponse({
        tableName,
        sessionId,
        userId,
        key,
        hash,
        token,
        durationMinutes,
        now,
      });
    } catch (error) {
      try {
        await rollbackSessionReservation({ tableName, sessionId, userId, key, monthKey });
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
    writeSafeLog({
      ...baseLogMetadata(),
      level: safeError instanceof SafeHttpError && safeError.statusCode < 500 ? "WARN" : "ERROR",
      operation: OPERATION,
      result: isProviderError ? "provider_unavailable" : resultForError(safeError),
      requestId: event.requestContext.requestId,
      sessionRef,
      durationMs: Date.now() - startedAt,
    });
    return errorResponse(safeError);
  }
}
