import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { fingerprintInterviewEvent, validateIdempotentAppend } from "../../src/lib/p1/events";
import {
  documentClient,
  positiveIntegerEnvironment,
  requiredEnvironment,
  sqsClient,
} from "./shared/aws-clients";
import {
  appendEventBatchSchema,
  interviewEventSchema,
  type AppendEventBatch,
  type GradingMessage,
  type InterviewEvent,
} from "./shared/contracts";
import {
  authenticatedUserId,
  errorResponse,
  jsonResponse,
  parseJsonRequest,
  SafeHttpError,
  type ApiGatewayV2Event,
  type ApiResponse,
} from "./shared/http";
import { baseLogMetadata, emitMetric, hashReference, writeSafeLog } from "./shared/logging";

interface SessionRecord {
  sessionId?: unknown;
  userId?: unknown;
  lastSequence?: unknown;
  eventCount?: unknown;
  sessionEndsAt?: unknown;
  status?: unknown;
}

interface StoredEventRecord {
  eventId?: unknown;
  sessionId?: unknown;
  sequence?: unknown;
  occurredAt?: unknown;
  eventType?: unknown;
  payload?: unknown;
}

interface SessionState {
  lastSequence: number;
  eventCount: number;
  sessionEndsAt: string;
  status: "created" | "completed";
  events: InterviewEvent[];
}

const OPERATION = "event.append" as const;
const MAX_APPEND_ATTEMPTS = 3;
export const PILOT_MAX_SESSION_EVENTS = 500;
export const PILOT_MAX_APPEND_GRACE_SECONDS = 120;

function eventSortKey(event: InterviewEvent): string {
  return `EVENT#${String(event.sequence).padStart(16, "0")}`;
}

function asInterviewEvent(item: StoredEventRecord): InterviewEvent | undefined {
  const parsed = interviewEventSchema.safeParse({
    id: item.eventId,
    sessionId: item.sessionId,
    sequence: item.sequence,
    occurredAt: item.occurredAt,
    type: item.eventType,
    payload: item.payload,
  });
  return parsed.success ? parsed.data : undefined;
}

async function loadSessionState(
  tableName: string,
  sessionId: string,
  userId: string,
): Promise<SessionState> {
  const sessionResponse = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `SESSION#${sessionId}`, SK: "META" },
    ConsistentRead: true,
    ProjectionExpression: "sessionId, userId, lastSequence, eventCount, sessionEndsAt, #status",
    ExpressionAttributeNames: { "#status": "status" },
  }));
  const session = sessionResponse.Item as SessionRecord | undefined;
  if (session?.sessionId !== sessionId || session.userId !== userId) {
    throw new SafeHttpError(404, "session_not_found", "The interview session was not found.");
  }
  if (typeof session.lastSequence !== "number" || !Number.isSafeInteger(session.lastSequence)) {
    throw new Error("Session sequence state is invalid.");
  }
  if (session.status !== "created" && session.status !== "completed") {
    throw new Error("Session lifecycle state is invalid.");
  }
  if (typeof session.sessionEndsAt !== "string" || !Number.isFinite(Date.parse(session.sessionEndsAt))) {
    throw new Error("Session end time is invalid.");
  }
  if (
    session.eventCount !== undefined &&
    (typeof session.eventCount !== "number" ||
      !Number.isSafeInteger(session.eventCount) ||
      session.eventCount < 0)
  ) {
    throw new Error("Session event count is invalid.");
  }

  const stored: InterviewEvent[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :eventPrefix)",
      ExpressionAttributeValues: { ":pk": `SESSION#${sessionId}`, ":eventPrefix": "EVENT#" },
      ProjectionExpression: "eventId, sessionId, sequence, occurredAt, eventType, payload",
      ConsistentRead: true,
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of response.Items ?? []) {
      const event = asInterviewEvent(item as StoredEventRecord);
      if (!event) throw new Error("Stored interview event failed its canonical schema.");
      stored.push(event);
    }
    exclusiveStartKey = response.LastEvaluatedKey;
    if (stored.length > 5_000) throw new Error("Session event count exceeds the supported pilot bound.");
  } while (exclusiveStartKey);

  return {
    lastSequence: session.lastSequence,
    eventCount: typeof session.eventCount === "number" ? session.eventCount : stored.length,
    sessionEndsAt: session.sessionEndsAt,
    status: session.status,
    events: stored,
  };
}

export function assertSessionAcceptsNewEvents(input: {
  state: Pick<SessionState, "eventCount" | "sessionEndsAt" | "status">;
  acceptedEventCount: number;
  maxSessionEvents: number;
  appendGraceSeconds: number;
  now: Date;
}): void {
  if (input.state.status !== "created") {
    throw new SafeHttpError(409, "session_closed", "The interview session is already closed.");
  }
  const latestAcceptedAt = Date.parse(input.state.sessionEndsAt) + input.appendGraceSeconds * 1_000;
  if (!Number.isFinite(latestAcceptedAt) || input.now.getTime() > latestAcceptedAt) {
    throw new SafeHttpError(409, "session_expired", "The interview evidence window has closed.");
  }
  if (input.state.eventCount + input.acceptedEventCount > input.maxSessionEvents) {
    throw new SafeHttpError(409, "session_event_limit", "The interview evidence limit has been reached.");
  }
}

async function transactAppend(
  tableName: string,
  sessionId: string,
  userId: string,
  currentSequence: number,
  currentEventCount: number,
  events: readonly InterviewEvent[],
  appendGraceSeconds: number,
  now: Date,
): Promise<void> {
  if (events.length === 0) return;
  const lastAcceptedSequence = events.at(-1)?.sequence;
  if (lastAcceptedSequence === undefined) return;
  const nextSequence = Math.max(currentSequence, lastAcceptedSequence);
  const completesSession = events.some((event) => event.type === "interview.completed");
  const nextEventCount = currentEventCount + events.length;
  const minimumSessionEndsAt = new Date(now.getTime() - appendGraceSeconds * 1_000).toISOString();

  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: tableName,
          Key: { PK: `SESSION#${sessionId}`, SK: "META" },
          UpdateExpression:
            "SET lastSequence = :nextSequence, eventCount = :nextEventCount, #status = :nextStatus, updatedAt = :updatedAt",
          ConditionExpression:
            "userId = :userId AND lastSequence = :currentSequence AND eventCount = :currentEventCount AND #status = :openStatus AND sessionEndsAt >= :minimumSessionEndsAt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":userId": userId,
            ":currentSequence": currentSequence,
            ":nextSequence": nextSequence,
            ":currentEventCount": currentEventCount,
            ":nextEventCount": nextEventCount,
            ":openStatus": "created",
            ":nextStatus": completesSession ? "completed" : "created",
            ":minimumSessionEndsAt": minimumSessionEndsAt,
            ":updatedAt": now.toISOString(),
          },
        },
      },
      ...events.map((event) => ({
        Put: {
          TableName: tableName,
          Item: {
            PK: `SESSION#${sessionId}`,
            SK: eventSortKey(event),
            entityType: "InterviewEvent",
            eventId: event.id,
            sessionId: event.sessionId,
            sequence: event.sequence,
            occurredAt: event.occurredAt,
            eventType: event.type,
            payload: event.payload,
            receivedAt: now.toISOString(),
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      })),
      ...events.map((event) => ({
        Put: {
          TableName: tableName,
          Item: {
            PK: `SESSION#${sessionId}`,
            SK: `EVENT_ID#${event.id}`,
            entityType: "EventIdentity",
            eventId: event.id,
            sequence: event.sequence,
            createdAt: new Date().toISOString(),
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      })),
    ],
  }));
}

function validateAgainstState(batch: AppendEventBatch, state: SessionState) {
  const requestedIds = new Set(batch.events.map((event) => event.id));
  const requestedSequences = new Set(batch.events.map((event) => event.sequence));
  const relevantExisting = state.events
    .filter((event) => requestedIds.has(event.id) || requestedSequences.has(event.sequence))
    .map((event) => ({
      id: event.id,
      sequence: event.sequence,
      fingerprint: fingerprintInterviewEvent(event),
    }));

  return validateIdempotentAppend({
    events: batch.events,
    lastSequence: state.lastSequence,
    existing: relevantExisting,
  });
}

async function appendWithOptimisticRetry(
  tableName: string,
  batch: AppendEventBatch,
  userId: string,
  maxSessionEvents: number,
  appendGraceSeconds: number,
) {
  for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt += 1) {
    const state = await loadSessionState(tableName, batch.sessionId, userId);
    const validation = validateAgainstState(batch, state);
    if (validation.conflict) {
      throw new SafeHttpError(
        409,
        "event_sequence_conflict",
        "An event ID or sequence conflicts with previously stored evidence.",
      );
    }
    if (validation.accepted.length === 0) {
      return {
        acceptedIds: [] as string[],
        duplicateIds: validation.duplicateIds,
        lastSequence: state.lastSequence,
      };
    }
    const now = new Date();
    assertSessionAcceptsNewEvents({
      state,
      acceptedEventCount: validation.accepted.length,
      maxSessionEvents,
      appendGraceSeconds,
      now,
    });

    try {
      await transactAppend(
        tableName,
        batch.sessionId,
        userId,
        state.lastSequence,
        state.eventCount,
        validation.accepted,
        appendGraceSeconds,
        now,
      );
      return {
        acceptedIds: validation.accepted.map((event) => event.id),
        duplicateIds: validation.duplicateIds,
        lastSequence: Math.max(
          state.lastSequence,
          validation.accepted.at(-1)?.sequence ?? state.lastSequence,
        ),
      };
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
      if (attempt === MAX_APPEND_ATTEMPTS) {
        throw new SafeHttpError(409, "event_sequence_conflict", "Concurrent event writes conflicted. Retry the batch.");
      }
    }
  }
  throw new Error("Event append retry loop exited unexpectedly.");
}

export function gradingMessagesForPersistedEvents(
  batch: AppendEventBatch,
  userId: string,
  persistedEventIds: ReadonlySet<string>,
): GradingMessage[] {
  const messages: GradingMessage[] = [];
  for (const event of batch.events) {
    if (
      !persistedEventIds.has(event.id) ||
      event.type !== "interview.completed" ||
      !event.payload.gradingRequested
    ) continue;
    messages.push({
      sessionId: event.sessionId,
      userId,
      completionEventId: event.id,
    });
  }
  return messages;
}

async function enqueueRequestedGrading(
  batch: AppendEventBatch,
  userId: string,
  persistedEventIds: ReadonlySet<string>,
): Promise<void> {
  for (const message of gradingMessagesForPersistedEvents(batch, userId, persistedEventIds)) {
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: requiredEnvironment("GRADING_QUEUE_URL"),
      MessageBody: JSON.stringify(message),
    }));
    emitMetric("interview_completed", 1, "Count");
  }
}

function errorResult(error: unknown) {
  if (error instanceof SafeHttpError) {
    if (error.errorCode.includes("conflict")) return "idempotency_conflict" as const;
    if (error.statusCode === 401) return "unauthorized" as const;
    if (error.statusCode === 404) return "not_found" as const;
    return "invalid_request" as const;
  }
  return "internal_error" as const;
}

export async function handler(event: ApiGatewayV2Event): Promise<ApiResponse> {
  const startedAt = Date.now();
  let sessionRef: string | undefined;
  try {
    const tableName = requiredEnvironment("TABLE_NAME");
    const maxSessionEvents = positiveIntegerEnvironment("MAX_SESSION_EVENTS", PILOT_MAX_SESSION_EVENTS);
    const appendGraceSeconds = positiveIntegerEnvironment(
      "SESSION_APPEND_GRACE_SECONDS",
      PILOT_MAX_APPEND_GRACE_SECONDS,
    );
    if (maxSessionEvents > PILOT_MAX_SESSION_EVENTS) {
      throw new Error("MAX_SESSION_EVENTS exceeds the P1 pilot hard cap.");
    }
    if (appendGraceSeconds > PILOT_MAX_APPEND_GRACE_SECONDS) {
      throw new Error("SESSION_APPEND_GRACE_SECONDS exceeds the P1 pilot hard cap.");
    }
    const userId = authenticatedUserId(event);
    const parsed = appendEventBatchSchema.safeParse(parseJsonRequest(event, 260 * 1_024));
    if (!parsed.success) {
      throw new SafeHttpError(400, "invalid_event_batch", "The event batch does not match the supported schema.");
    }
    const batch = parsed.data;
    sessionRef = hashReference(batch.sessionId);
    const result = await appendWithOptimisticRetry(
      tableName,
      batch,
      userId,
      maxSessionEvents,
      appendGraceSeconds,
    );
    // Exact duplicate completion events are deliberately re-enqueued. This
    // repairs the DynamoDB-committed/SQS-send-failed window; the grader lease
    // makes the resulting queue delivery idempotent before calling Gemini.
    await enqueueRequestedGrading(
      batch,
      userId,
      new Set([...result.acceptedIds, ...result.duplicateIds]),
    );

    writeSafeLog({
      ...baseLogMetadata(),
      level: "INFO",
      operation: OPERATION,
      result: result.acceptedIds.length === 0 ? "idempotent_replay" : "success",
      requestId: event.requestContext.requestId,
      sessionRef,
      durationMs: Date.now() - startedAt,
      itemCount: result.acceptedIds.length,
    });
    return jsonResponse(result.acceptedIds.length === 0 ? 200 : 202, {
      acceptedEventIds: result.acceptedIds,
      duplicateEventIds: result.duplicateIds,
      lastSequence: result.lastSequence,
    });
  } catch (error) {
    if (error instanceof SafeHttpError && error.errorCode.includes("conflict")) {
      emitMetric("idempotency_conflict", 1, "Count");
    }
    writeSafeLog({
      ...baseLogMetadata(),
      level: error instanceof SafeHttpError && error.statusCode < 500 ? "WARN" : "ERROR",
      operation: OPERATION,
      result: errorResult(error),
      requestId: event.requestContext.requestId,
      sessionRef,
      durationMs: Date.now() - startedAt,
    });
    return errorResponse(error);
  }
}
