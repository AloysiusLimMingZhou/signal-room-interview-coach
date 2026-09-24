import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { documentClient } from "./shared/aws-clients";
import { interviewEventSchema, type InterviewEvent } from "./shared/contracts";
import { SafeHttpError } from "./shared/http";
import { HISTORY_SORT_PREFIX } from "./shared/table-keys";

const sessionStateSchema = z.object({
  sessionId: z.string().uuid(), userId: z.string().min(1),
  lastSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  eventCount: z.number().int().nonnegative().optional(),
  sessionEndsAt: z.string().datetime({ offset: true }),
  status: z.enum(["created", "completed"]),
  historySk: z.string().startsWith(HISTORY_SORT_PREFIX).optional(),
  channel: z.enum(["voice", "text"]).default("voice"),
  durationMinutes: z.number().int().min(1).max(30).default(10),
}).refine((session) => session.channel === "text" || session.durationMinutes <= 10);

export interface SessionState {
  lastSequence: number;
  eventCount: number;
  sessionEndsAt: string;
  durationMinutes: number;
  status: "created" | "completed";
  historySk?: string;
  events: InterviewEvent[];
}

export async function loadSessionState(tableName: string, sessionId: string, userId: string): Promise<SessionState> {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName, Key: { PK: `SESSION#${sessionId}`, SK: "META" }, ConsistentRead: true,
    ProjectionExpression: "sessionId, userId, lastSequence, eventCount, sessionEndsAt, historySk, #status, channel, durationMinutes",
    ExpressionAttributeNames: { "#status": "status" },
  }));
  if (response.Item?.sessionId !== sessionId || response.Item?.userId !== userId) {
    throw new SafeHttpError(404, "session_not_found", "The interview session was not found.");
  }
  const session = sessionStateSchema.parse(response.Item);
  const stored: InterviewEvent[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await documentClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :eventPrefix)",
      ExpressionAttributeValues: { ":pk": `SESSION#${sessionId}`, ":eventPrefix": "EVENT#" },
      ProjectionExpression: "eventId, sessionId, sequence, occurredAt, eventType, payload",
      ConsistentRead: true, ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of page.Items ?? []) {
      const event = interviewEventSchema.parse({
        id: item.eventId, sessionId: item.sessionId, sequence: item.sequence,
        occurredAt: item.occurredAt, type: item.eventType, payload: item.payload,
      });
      if (event.sessionId !== sessionId) throw new Error("Stored event belongs to a different session.");
      stored.push(event);
    }
    exclusiveStartKey = page.LastEvaluatedKey;
    if (stored.length > 5_000) throw new Error("Session event count exceeds the supported pilot bound.");
  } while (exclusiveStartKey);
  return { ...session, eventCount: session.eventCount ?? stored.length, events: stored };
}

export function assertCompletionDuration(events: readonly InterviewEvent[], durationMinutes: number): void {
  if (events.some((event) => event.type === "interview.completed" && event.payload.durationMs > durationMinutes * 60_000)) {
    throw new SafeHttpError(400, "invalid_completion_duration", "Completion duration exceeds this session's limit.");
  }
}
