import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { textTurnResponseSchema, type TextTurnRequest, type TextTurnResponse } from "../../src/lib/p1/session-v2";
import { codeLanguageSchema, levelSchema, questionIdSchema, trackSchema } from "../../src/lib/questions/schema";
import { documentClient } from "./shared/aws-clients";
import { SafeHttpError } from "./shared/http";
import { sessionMetaKey } from "./shared/table-keys";
import { textHistoryRowSchema, type TextHistoryRow } from "./shared/text-gemini";

const stateSchema = z.object({
  sessionId: z.string().uuid(), userId: z.string().min(1), contractVersion: z.literal(2),
  channel: z.literal("text"), track: trackSchema, level: levelSchema, language: codeLanguageSchema.optional(),
  questionId: questionIdSchema, model: z.literal("gemini-2.5-flash-lite"),
  status: z.enum(["created", "completed", "deleting"]), sessionEndsAt: z.string().datetime({ offset: true }),
  textTurnCount: z.number().int().min(0).max(40), textGenerationCount: z.number().int().min(0).max(40).default(0),
  textLeaseUntil: z.number().int().nonnegative().optional(), twistUsed: z.boolean().default(false), timeWarningUsed: z.boolean().default(false),
}).refine((state) => state.track === "coding" ? state.language !== undefined : state.language === undefined);
export type TextSessionState = z.infer<typeof stateSchema>;
interface TurnIdentity { tableName: string; sessionId: string; userId: string; turnId: string; hash: string }
export interface TurnLease extends TurnIdentity { leaseId: string; now: Date; state: TextSessionState; maxTurns: number; request: TextTurnRequest }
const turnKey = (sessionId: string, turnId: string) => ({ PK: `SESSION#${sessionId}`, SK: `TEXT_TURN_ID#${turnId}` });
export function busyTurn(): SafeHttpError { return new SafeHttpError(409, "turn_conflict", "A turn is already running or has changed. Retry shortly.", { "Retry-After": "1" }); }

export async function readTextSession(tableName: string, sessionId: string, userId: string): Promise<TextSessionState> {
  const response = await documentClient.send(new GetCommand({ TableName: tableName, Key: sessionMetaKey(sessionId), ConsistentRead: true }));
  if (response.Item?.userId !== userId || response.Item?.sessionId !== sessionId || response.Item?.status === "deleting") {
    throw new SafeHttpError(404, "session_not_found", "The interview session was not found.");
  }
  if (response.Item.channel !== "text") throw new SafeHttpError(409, "channel_mismatch", "This session does not use text turns.");
  return stateSchema.parse(response.Item);
}

export async function replayTextTurn(input: TurnIdentity): Promise<TextTurnResponse | undefined> {
  const result = await documentClient.send(new GetCommand({ TableName: input.tableName, Key: turnKey(input.sessionId, input.turnId), ConsistentRead: true }));
  if (!result.Item) return undefined;
  if (result.Item.requestHash !== input.hash) throw busyTurn();
  if (result.Item.status !== "complete") return undefined;
  const response = textTurnResponseSchema.parse(result.Item.response);
  if (response.turnId !== input.turnId) throw new Error("Stored turn identity mismatch.");
  return response;
}

/** The attempt counter is never refunded, including on ambiguous timeouts. */
export async function claimTextTurn(input: TurnLease): Promise<void> {
  const leaseUntil = input.now.getTime() + 30_000; // Longer than the entire 20-second Lambda invocation.
  await documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: input.tableName, Key: sessionMetaKey(input.sessionId),
      UpdateExpression: "SET textLeaseId = :leaseId, textLeaseUntil = :until, textGenerationCount = if_not_exists(textGenerationCount, :zero) + :one",
      ConditionExpression: "userId = :userId AND #status = :created AND textTurnCount = :count AND textTurnCount < :limit AND sessionEndsAt > :isoNow AND (attribute_not_exists(textLeaseUntil) OR textLeaseUntil < :now) AND (attribute_not_exists(textGenerationCount) OR textGenerationCount < :limit)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":userId": input.userId, ":created": "created", ":count": input.state.textTurnCount, ":limit": input.maxTurns,
        ":isoNow": input.now.toISOString(), ":now": input.now.getTime(), ":leaseId": input.leaseId, ":until": leaseUntil, ":zero": 0, ":one": 1 },
    } },
    { Put: {
      TableName: input.tableName,
      Item: { ...turnKey(input.sessionId, input.turnId), entityType: "TextTurnIdentity", status: "pending", requestHash: input.hash, leaseId: input.leaseId, leaseUntil },
      ConditionExpression: "attribute_not_exists(PK) OR (requestHash = :hash AND (#status = :failed OR (#status = :pending AND leaseUntil < :now)))",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":hash": input.hash, ":failed": "failed", ":pending": "pending", ":now": input.now.getTime() },
    } },
  ] }));
}

export function historyInput(request: TextTurnRequest): TextHistoryRow["input"] {
  return request.kind === "candidate" ? { kind: request.kind, text: request.text } : { kind: request.kind };
}
export async function loadTextHistory(tableName: string, sessionId: string): Promise<TextHistoryRow[]> {
  const response = await documentClient.send(new QueryCommand({
    TableName: tableName, KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": `SESSION#${sessionId}`, ":prefix": "TEXT_TURN#" },
    ConsistentRead: true, ScanIndexForward: false, Limit: 40,
  }));
  const selected: TextHistoryRow[] = []; let chars = 0;
  for (const item of response.Items ?? []) {
    const row = textHistoryRowSchema.parse(item);
    const size = JSON.stringify(row).length;
    if (chars + size > 24_000) break;
    selected.push(row); chars += size;
  }
  return selected.reverse();
}

export async function commitTextTurn(input: TurnLease, response: TextTurnResponse): Promise<void> {
  const control = input.request.kind === "twist" ? ", twistUsed = :yes" : input.request.kind === "time-warning" ? ", timeWarningUsed = :yes" : "";
  await documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: input.tableName, Key: sessionMetaKey(input.sessionId),
      UpdateExpression: `SET textTurnCount = :next${control} REMOVE textLeaseId, textLeaseUntil`,
      ConditionExpression: "userId = :userId AND #status = :created AND textLeaseId = :leaseId AND textTurnCount = :count",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":userId": input.userId, ":created": "created", ":leaseId": input.leaseId,
        ":count": input.state.textTurnCount, ":next": response.turnIndex, ...(control ? { ":yes": true } : {}) },
    } },
    { Put: {
      TableName: input.tableName, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      Item: { PK: `SESSION#${input.sessionId}`, SK: `TEXT_TURN#${String(response.turnIndex).padStart(4, "0")}`, entityType: "TextTurn",
        turnId: input.turnId, turnIndex: response.turnIndex, input: historyInput(input.request), interviewerText: response.interviewerText, createdAt: input.now.toISOString() },
    } },
    { Update: {
      TableName: input.tableName, Key: turnKey(input.sessionId, input.turnId),
      UpdateExpression: "SET #status = :complete, #response = :response REMOVE leaseId, leaseUntil",
      ConditionExpression: "#status = :pending AND leaseId = :leaseId AND requestHash = :hash",
      ExpressionAttributeNames: { "#status": "status", "#response": "response" },
      ExpressionAttributeValues: { ":complete": "complete", ":pending": "pending", ":leaseId": input.leaseId, ":hash": input.hash, ":response": response },
    } },
  ] }));
}

export async function failTextTurn(input: TurnLease): Promise<void> {
  await documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: input.tableName, Key: sessionMetaKey(input.sessionId), UpdateExpression: "REMOVE textLeaseId, textLeaseUntil",
      ConditionExpression: "userId = :userId AND textLeaseId = :leaseId AND #status = :created",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":userId": input.userId, ":leaseId": input.leaseId, ":created": "created" },
    } },
    { Update: {
      TableName: input.tableName, Key: turnKey(input.sessionId, input.turnId), UpdateExpression: "SET #status = :failed REMOVE leaseId, leaseUntil",
      ConditionExpression: "#status = :pending AND leaseId = :leaseId",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":failed": "failed", ":pending": "pending", ":leaseId": input.leaseId },
    } },
  ] }));
}
