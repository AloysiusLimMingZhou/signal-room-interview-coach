import { GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { AccessRole, ItemKey } from "../lib/access-policy";
import { documentClient } from "./shared/aws-clients";
import type { SessionRequest } from "./shared/contracts";
import type { ProvisionedToken } from "./shared/gemini";
import { SafeHttpError, secondsUntilNextUtcMonth } from "./shared/http";
import { historyKey, sessionMetaKey } from "./shared/table-keys";

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

interface IdempotencyRecord {
  createdAt?: unknown;
  requestHash?: unknown;
  sessionId?: unknown;
}

export interface SessionResponseRecord {
  requestHash?: unknown;
  sessionId?: unknown;
  token?: unknown;
  model?: unknown;
  tokenExpiresAt?: unknown;
  durationMinutes?: unknown;
}

export interface QuotaReservation {
  keys: { global: ItemKey; user: ItemKey };
  globalLimit: number;
  userLimit: number;
}

// Phase 1 sessions have no question bank yet, so history shows the track label.
const LEGACY_TRACK_TITLES: Record<SessionRequest["track"], string> = {
  "system-design": "System design",
  "ml-design": "ML system design",
  algorithms: "Algorithms",
};

const MUST_NOT_EXIST = "attribute_not_exists(PK) AND attribute_not_exists(SK)";

function quotaExpiry(now: Date): number {
  return Math.floor(Date.UTC(now.getUTCFullYear() + 2, now.getUTCMonth() + 1, 1) / 1_000);
}

function idempotencyKeys(userId: string, key: string): ItemKey {
  return { PK: `USER#${userId}`, SK: `SESSION_REQUEST#${key}` };
}

function responseKeys(userId: string, key: string): ItemKey {
  return { PK: `USER#${userId}`, SK: `SESSION_RESPONSE#${key}` };
}

export async function getIdempotencyRecord(
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

export async function getSessionResponse(
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

async function quotaUsed(tableName: string, key: ItemKey): Promise<number> {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: key,
    ConsistentRead: true,
    ProjectionExpression: "used",
  }));
  const used = (response.Item as { used?: unknown } | undefined)?.used;
  return typeof used === "number" && Number.isSafeInteger(used) ? used : 0;
}

/** A cheap pre-check; the transaction's conditions remain the real guarantee. */
export async function assertQuotaLikelyAvailable(
  tableName: string,
  reservation: QuotaReservation,
  now: Date,
): Promise<void> {
  const [globalUsed, userUsed] = await Promise.all([
    quotaUsed(tableName, reservation.keys.global),
    quotaUsed(tableName, reservation.keys.user),
  ]);
  if (globalUsed >= reservation.globalLimit || userUsed >= reservation.userLimit) {
    throw new SafeHttpError(
      429,
      "monthly_quota_exhausted",
      "The monthly voice interview allowance has been reached.",
      { "Retry-After": String(secondsUntilNextUtcMonth(now)) },
    );
  }
}

function quotaIncrement(tableName: string, key: ItemKey, limit: number, now: string, expiresAt: number): TransactItem {
  return {
    Update: {
      TableName: tableName,
      Key: key,
      UpdateExpression: "SET #used = if_not_exists(#used, :zero) + :one, #limit = :limit, updatedAt = :now, expiresAt = :expiresAt",
      ConditionExpression: "attribute_not_exists(#used) OR #used < :limit",
      ExpressionAttributeNames: { "#used": "used", "#limit": "limit" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": limit, ":now": now, ":expiresAt": expiresAt },
    },
  };
}

function quotaDecrement(tableName: string, key: ItemKey): TransactItem {
  return {
    Update: {
      TableName: tableName,
      Key: key,
      UpdateExpression: "SET #used = #used - :one",
      ConditionExpression: "#used >= :one",
      ExpressionAttributeNames: { "#used": "used" },
      ExpressionAttributeValues: { ":one": 1 },
    },
  };
}

export async function persistSession(input: {
  tableName: string;
  sessionId: string;
  userId: string;
  role: Exclude<AccessRole, "none">;
  key: string;
  hash: string;
  request: SessionRequest;
  now: Date;
  durationMinutes: number;
  model: string;
  reservation: QuotaReservation;
  historySk: string;
}): Promise<void> {
  const expiresAt = quotaExpiry(input.now);
  const createdAt = input.now.toISOString();
  const sessionEndsAt = new Date(input.now.getTime() + input.durationMinutes * 60_000).toISOString();

  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      quotaIncrement(input.tableName, input.reservation.keys.global, input.reservation.globalLimit, createdAt, expiresAt),
      quotaIncrement(input.tableName, input.reservation.keys.user, input.reservation.userLimit, createdAt, expiresAt),
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
          ConditionExpression: MUST_NOT_EXIST,
        },
      },
      {
        Put: {
          TableName: input.tableName,
          Item: {
            ...sessionMetaKey(input.sessionId),
            entityType: "InterviewSession",
            sessionId: input.sessionId,
            userId: input.userId,
            role: input.role,
            channel: "voice",
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
            historySk: input.historySk,
          },
          ConditionExpression: MUST_NOT_EXIST,
        },
      },
      {
        Put: {
          TableName: input.tableName,
          Item: {
            ...historyKey(input.userId, input.historySk),
            entityType: "SessionHistory",
            sessionId: input.sessionId,
            createdAt,
            channel: "voice",
            track: input.request.track,
            level: input.request.difficulty,
            questionTitle: LEGACY_TRACK_TITLES[input.request.track],
            status: "active",
          },
          ConditionExpression: MUST_NOT_EXIST,
        },
      },
    ],
  }));
}

export async function persistProvisionedResponse(input: {
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
          Key: sessionMetaKey(input.sessionId),
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
          ConditionExpression: MUST_NOT_EXIST,
        },
      },
    ],
  }));
}

export async function rollbackSessionReservation(input: {
  tableName: string;
  sessionId: string;
  userId: string;
  key: string;
  reservation: QuotaReservation;
  historySk: string;
}): Promise<void> {
  const ownedBySession = {
    ConditionExpression: "sessionId = :sessionId",
    ExpressionAttributeValues: { ":sessionId": input.sessionId },
  };
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      quotaDecrement(input.tableName, input.reservation.keys.global),
      quotaDecrement(input.tableName, input.reservation.keys.user),
      { Delete: { TableName: input.tableName, Key: idempotencyKeys(input.userId, input.key), ...ownedBySession } },
      {
        Delete: {
          TableName: input.tableName,
          Key: sessionMetaKey(input.sessionId),
          ConditionExpression: "userId = :userId AND #status = :provisioning",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":userId": input.userId, ":provisioning": "provisioning" },
        },
      },
      { Delete: { TableName: input.tableName, Key: historyKey(input.userId, input.historySk), ...ownedBySession } },
    ],
  }));
}
