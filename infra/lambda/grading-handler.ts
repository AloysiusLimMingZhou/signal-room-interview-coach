import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ZodError } from "zod";
import { documentClient, requiredEnvironment } from "./shared/aws-clients";
import {
  gradingMessageSchema,
  interviewEventSchema,
  type GradingMessage,
  type InterviewEvent,
} from "./shared/contracts";
import { gradeEvidence, loadGeminiApiKey } from "./shared/gemini";
import { baseLogMetadata, emitMetric, hashReference, writeSafeLog } from "./shared/logging";

interface SqsRecord {
  messageId: string;
  body: string;
}

interface SqsEvent {
  Records: SqsRecord[];
}

interface BatchResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

interface SessionRecord {
  userId?: unknown;
  track?: unknown;
  difficulty?: unknown;
}

interface ReportRecord {
  status?: unknown;
  leaseId?: unknown;
  leaseExpiresAt?: unknown;
  report?: unknown;
}

interface StoredEventRecord {
  eventId?: unknown;
  sessionId?: unknown;
  sequence?: unknown;
  occurredAt?: unknown;
  eventType?: unknown;
  payload?: unknown;
}

const OPERATION = "grading.run" as const;
const MAX_EVIDENCE_BYTES = 400 * 1_024;
const REPORT_SORT_KEY = "REPORT#P1#v1";

function asInterviewEvent(item: StoredEventRecord): InterviewEvent {
  return interviewEventSchema.parse({
    id: item.eventId,
    sessionId: item.sessionId,
    sequence: item.sequence,
    occurredAt: item.occurredAt,
    type: item.eventType,
    payload: item.payload,
  });
}

async function getSession(tableName: string, message: GradingMessage): Promise<SessionRecord> {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `SESSION#${message.sessionId}`, SK: "META" },
    ConsistentRead: true,
    ProjectionExpression: "userId, track, difficulty",
  }));
  const session = response.Item as SessionRecord | undefined;
  if (!session || session.userId !== message.userId) throw new Error("Grading session ownership check failed.");
  return session;
}

async function getReportRecord(tableName: string, sessionId: string): Promise<ReportRecord | undefined> {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `SESSION#${sessionId}`, SK: REPORT_SORT_KEY },
    ConsistentRead: true,
    ProjectionExpression: "#status, leaseId, leaseExpiresAt, report",
    ExpressionAttributeNames: { "#status": "status" },
  }));
  return response.Item as ReportRecord | undefined;
}

function completedReport(record: ReportRecord | undefined): boolean {
  return record?.status === "complete" || record?.report !== undefined;
}

async function claimGrading(
  tableName: string,
  sessionId: string,
  leaseId: string,
  now: Date,
): Promise<"claimed" | "already-running-or-complete"> {
  const existing = await getReportRecord(tableName, sessionId);
  if (completedReport(existing)) return "already-running-or-complete";
  if (
    existing?.status === "grading" &&
    typeof existing.leaseExpiresAt === "number" &&
    existing.leaseExpiresAt >= Math.floor(now.getTime() / 1_000)
  ) return "already-running-or-complete";

  const leaseExpiresAt = Math.floor((now.getTime() + 90_000) / 1_000);
  try {
    await documentClient.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `SESSION#${sessionId}`,
        SK: REPORT_SORT_KEY,
        entityType: "EvidenceReport",
        status: "grading",
        leaseId,
        leaseExpiresAt,
        startedAt: now.toISOString(),
      },
      ConditionExpression:
        "attribute_not_exists(PK) OR (#status = :grading AND leaseExpiresAt < :now)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":grading": "grading",
        ":now": Math.floor(now.getTime() / 1_000),
      },
    }));
    return "claimed";
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      return "already-running-or-complete";
    }
    throw error;
  }
}

async function loadEvents(tableName: string, sessionId: string): Promise<InterviewEvent[]> {
  const events: InterviewEvent[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `SESSION#${sessionId}`, ":prefix": "EVENT#" },
      ProjectionExpression: "eventId, sessionId, sequence, occurredAt, eventType, payload",
      ConsistentRead: true,
      ExclusiveStartKey: exclusiveStartKey,
    }));
    events.push(...(response.Items ?? []).map((item) => asInterviewEvent(item as StoredEventRecord)));
    exclusiveStartKey = response.LastEvaluatedKey;
    if (events.length > 5_000) throw new Error("Grading evidence exceeds the supported event count.");
  } while (exclusiveStartKey);
  return events;
}

function boundedEvidence(events: InterviewEvent[]): InterviewEvent[] {
  const selected: InterviewEvent[] = [];
  let bytes = 2;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8") + 1;
    if (bytes + candidateBytes > MAX_EVIDENCE_BYTES) continue;
    selected.push(candidate);
    bytes += candidateBytes;
  }
  return selected.reverse();
}

async function gradeMessage(message: GradingMessage): Promise<"success" | "idempotent_replay"> {
  const tableName = requiredEnvironment("TABLE_NAME");
  const leaseId = randomUUID();
  const claim = await claimGrading(tableName, message.sessionId, leaseId, new Date());
  if (claim !== "claimed") return "idempotent_replay";

  const [session, events] = await Promise.all([
    getSession(tableName, message),
    loadEvents(tableName, message.sessionId),
  ]);
  const completion = events.find((event) => event.id === message.completionEventId);
  if (completion?.type !== "interview.completed" || !completion.payload.gradingRequested) {
    throw new Error("Grading completion evidence is missing.");
  }

  const evidence = boundedEvidence(events);
  if (evidence.length === 0) throw new Error("No grading evidence is available.");
  const apiKey = await loadGeminiApiKey();
  const report = await gradeEvidence(apiKey, {
    interview: { track: session.track, difficulty: session.difficulty },
    events: evidence,
  });

  const evidenceIds = new Set(evidence.map((event) => event.id));
  for (const score of report.scores) {
    for (const reference of score.evidenceReferences) {
      if (!evidenceIds.has(reference.eventId)) {
        emitMetric("evidence_reference_invalid", 1, "Count");
        throw new Error("Grading report cited evidence outside the session.");
      }
    }
  }

  try {
    await documentClient.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `SESSION#${message.sessionId}`,
        SK: REPORT_SORT_KEY,
        entityType: "EvidenceReport",
        status: "complete",
        rubricVersion: "p1-v1",
        provider: "gemini",
        model: process.env.GEMINI_GRADER_MODEL ?? "gemini-2.5-flash-lite",
        createdAt: new Date().toISOString(),
        completionEventId: message.completionEventId,
        report,
      },
      ConditionExpression: "#status = :grading AND leaseId = :leaseId",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":grading": "grading", ":leaseId": leaseId },
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      return "idempotent_replay";
    }
    throw error;
  }
  return "success";
}

export async function handler(event: SqsEvent): Promise<BatchResponse> {
  const failures: BatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    const startedAt = Date.now();
    let sessionRef: string | undefined;
    try {
      const parsedBody = JSON.parse(record.body) as unknown;
      const message = gradingMessageSchema.parse(parsedBody);
      sessionRef = hashReference(message.sessionId);
      const result = await gradeMessage(message);
      const durationMs = Date.now() - startedAt;
      emitMetric("grading_latency_ms", durationMs, "Milliseconds");
      writeSafeLog({
        ...baseLogMetadata(),
        level: "INFO",
        operation: OPERATION,
        result,
        requestId: record.messageId,
        sessionRef,
        provider: "gemini",
        model: process.env.GEMINI_GRADER_MODEL ?? "gemini-2.5-flash-lite",
        durationMs,
      });
    } catch (error) {
      const schemaFailure = error instanceof ZodError;
      if (schemaFailure) emitMetric("grading_schema_failure", 1, "Count");
      writeSafeLog({
        ...baseLogMetadata(),
        level: "ERROR",
        operation: OPERATION,
        result: schemaFailure ? "schema_failure" : "internal_error",
        requestId: record.messageId,
        sessionRef,
        durationMs: Date.now() - startedAt,
      });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
