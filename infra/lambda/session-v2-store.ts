import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { getUtcMonthWindow } from "../../src/lib/p1/quota";
import { sessionResponseV2Schema, type SessionRequestV2, type SessionResponseV2 } from "../../src/lib/p1/session-v2";
import { questionIdSchema, type QuestionDefinition } from "../../src/lib/questions/schema";
import type { AccessRole, ItemKey } from "../lib/access-policy";
import { quotaIncrement, type QuotaReservation } from "./session-store";
import { documentClient } from "./shared/aws-clients";
import { SafeHttpError, secondsUntilNextUtcMonth } from "./shared/http";
import { historyKey, sessionMetaKey } from "./shared/table-keys";

const requestKey = (userId: string, key: string) => ({ PK: `USER#${userId}`, SK: `SESSION_REQUEST#${key}` });
const responseKey = (userId: string, key: string) => ({ PK: `USER#${userId}`, SK: `SESSION_RESPONSE#${key}` });
const mustNotExist = "attribute_not_exists(PK) AND attribute_not_exists(SK)";
const requestRecordSchema = z.object({
  createdAt: z.string().datetime({ offset: true }), requestHash: z.string().regex(/^[a-f0-9]{64}$/), sessionId: z.string().uuid(),
});

export async function replayV2Session(tableName: string, userId: string, key: string, hash: string, now: Date): Promise<SessionResponseV2 | undefined> {
  const result = await documentClient.send(new GetCommand({ TableName: tableName, Key: requestKey(userId, key), ConsistentRead: true }));
  if (!result.Item) return undefined;
  const original = requestRecordSchema.parse(result.Item);
  if (original.requestHash !== hash) throw new SafeHttpError(409, "idempotency_conflict", "That key was used for a different request.");
  if (now.getTime() - Date.parse(original.createdAt) > 120_000) {
    throw new SafeHttpError(409, "session_request_expired", "Start a new interview session request.");
  }
  const stored = await documentClient.send(new GetCommand({ TableName: tableName, Key: responseKey(userId, key), ConsistentRead: true }));
  if (!stored.Item) throw new SafeHttpError(409, "session_request_pending", "The original session request is still completing.", { "Retry-After": "1" });
  const response = sessionResponseV2Schema.parse(stored.Item.response);
  if (stored.Item.requestHash !== hash || response.sessionId !== original.sessionId || Date.parse(response.expiresAt) <= now.getTime()) {
    throw new SafeHttpError(409, "session_request_expired", "Start a new interview session request.");
  }
  return response;
}

export async function recentQuestionIds(tableName: string, userId: string): Promise<string[]> {
  const result = await documentClient.send(new QueryCommand({
    TableName: tableName, KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": `USER#${userId}`, ":prefix": "SESSION#" },
    ProjectionExpression: "questionId", ScanIndexForward: false, Limit: 20, ConsistentRead: true,
  }));
  return (result.Items ?? []).flatMap((item) => item.questionId === undefined ? [] : [questionIdSchema.parse(item.questionId)]);
}

export async function assertV2Quota(tableName: string, reservation: QuotaReservation, channel: "voice" | "text", now: Date): Promise<void> {
  const readUsed = async (key: ItemKey) => {
    const result = await documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true, ProjectionExpression: "used" }));
    return z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(result.Item?.used ?? 0);
  };
  const [globalUsed, userUsed] = await Promise.all([readUsed(reservation.keys.global), readUsed(reservation.keys.user)]);
  const scope = globalUsed >= reservation.globalLimit ? "global" : userUsed >= reservation.userLimit ? "user" : undefined;
  if (scope) throw new SafeHttpError(429, "monthly_quota_exhausted", `The monthly ${channel} interview allowance has been reached.`,
    { "Retry-After": String(secondsUntilNextUtcMonth(now)) }, { channel, scope, resetsAt: getUtcMonthWindow(now).endsAt });
}

interface SessionPersistence {
  tableName: string; sessionId: string; userId: string; role: Exclude<AccessRole, "none">;
  key: string; hash: string; now: Date; request: SessionRequestV2; question: QuestionDefinition;
  model: string; historySk: string; reservation: QuotaReservation; response?: SessionResponseV2;
}

function storedResponse(input: { userId: string; key: string; hash: string; now: Date }, response: SessionResponseV2) {
  return {
    ...responseKey(input.userId, input.key), entityType: "SessionResponse", requestHash: input.hash,
    sessionId: response.sessionId, response, createdAt: input.now.toISOString(), expiresAt: Math.floor(input.now.getTime() / 1_000) + 120,
  };
}

/** Text setup (including replay) is one transaction. Voice remains provisioning until its token is saved. */
export async function reserveV2Session(input: SessionPersistence): Promise<void> {
  const { request, question } = input;
  const createdAt = input.now.toISOString();
  const expiresAt = Math.floor(Date.UTC(input.now.getUTCFullYear() + 2, input.now.getUTCMonth() + 1, 1) / 1_000);
  await documentClient.send(new TransactWriteCommand({ TransactItems: [
    quotaIncrement(input.tableName, input.reservation.keys.global, input.reservation.globalLimit, createdAt, expiresAt),
    quotaIncrement(input.tableName, input.reservation.keys.user, input.reservation.userLimit, createdAt, expiresAt),
    { Put: { TableName: input.tableName, ConditionExpression: mustNotExist, Item: {
      ...requestKey(input.userId, input.key), entityType: "SessionRequest", sessionId: input.sessionId,
      requestHash: input.hash, createdAt, expiresAt,
    } } },
    { Put: { TableName: input.tableName, ConditionExpression: mustNotExist, Item: {
      ...sessionMetaKey(input.sessionId), entityType: "InterviewSession", contractVersion: 2,
      sessionId: input.sessionId, userId: input.userId, role: input.role, requestKey: input.key,
      channel: request.channel, track: request.track, level: request.level,
      ...(request.track === "coding" ? { language: request.language } : {}),
      questionId: question.id, provider: "gemini", model: input.model,
      durationMinutes: request.durationMinutes, status: request.channel === "text" ? "created" : "provisioning",
      lastSequence: 0, eventCount: 0, textTurnCount: 0, createdAt,
      sessionEndsAt: new Date(input.now.getTime() + request.durationMinutes * 60_000).toISOString(), historySk: input.historySk,
    } } },
    { Put: { TableName: input.tableName, ConditionExpression: mustNotExist, Item: {
      ...historyKey(input.userId, input.historySk), entityType: "SessionHistory", sessionId: input.sessionId,
      createdAt, channel: request.channel, track: request.track, level: request.level,
      questionId: question.id, questionTitle: question.title, status: "active",
    } } },
    ...(input.response ? [{ Put: { TableName: input.tableName, ConditionExpression: mustNotExist, Item: storedResponse(input, input.response) } }] : []),
  ] }));
}

export async function finalizeV2Voice(input: { tableName: string; userId: string; key: string; hash: string; now: Date; response: SessionResponseV2 }): Promise<void> {
  await documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: input.tableName, Key: sessionMetaKey(input.response.sessionId),
      UpdateExpression: "SET #status = :ready, credentialExpiresAt = :expiresAt",
      ConditionExpression: "userId = :userId AND #status = :provisioning",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":userId": input.userId, ":provisioning": "provisioning", ":ready": "created", ":expiresAt": input.response.expiresAt },
    } },
    { Put: { TableName: input.tableName, ConditionExpression: mustNotExist, Item: storedResponse(input, input.response) } },
  ] }));
}
