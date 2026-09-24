import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  meResponseSchema,
  reportResponseSchema,
  SESSION_LIST_MAX_LIMIT,
  sessionListResponseSchema,
  sessionSummarySchema,
  type MeResponse,
  type ReportResponse,
  type SessionListResponse,
} from "../../src/lib/p1/account";
import { getUtcMonthWindow } from "../../src/lib/p1/quota";
import {
  quotaKeys,
  userAllowance,
  type AccessRole,
  type AllowanceLimits,
  type ItemKey,
  type QuotaChannel,
} from "../lib/access-policy";
import { allowanceLimitsFromEnvironment } from "./shared/allowances";
import { documentClient, requiredEnvironment } from "./shared/aws-clients";
import {
  authenticatedRole,
  authenticatedUserId,
  errorResponse,
  jsonResponse,
  SafeHttpError,
  type ApiGatewayV2Event,
  type ApiResponse,
} from "./shared/http";
import { baseLogMetadata, writeSafeLog } from "./shared/logging";
import { HISTORY_SORT_PREFIX, reportKey, sessionMetaKey } from "./shared/table-keys";

const OPERATION = "account.read" as const;
const DEFAULT_LIST_LIMIT = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;
const LIMIT_PATTERN = /^[1-9][0-9]?$/;

function notFound(): SafeHttpError {
  return new SafeHttpError(404, "session_not_found", "The interview session was not found.");
}

function invalidQuery(message: string): SafeHttpError {
  return new SafeHttpError(400, "invalid_request", message);
}

async function usedCount(tableName: string, key: ItemKey): Promise<number> {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: key,
    ProjectionExpression: "used",
  }));
  const used = (response.Item as { used?: unknown } | undefined)?.used;
  return typeof used === "number" && Number.isSafeInteger(used) && used >= 0 ? used : 0;
}

async function allowanceFor(input: {
  tableName: string;
  channel: QuotaChannel;
  userId: string;
  role: AccessRole;
  limits: AllowanceLimits;
  now: Date;
}) {
  const window = getUtcMonthWindow(input.now);
  const keys = quotaKeys(input.channel, input.userId, window.key);
  const [globalUsed, userUsed] = await Promise.all([
    usedCount(input.tableName, keys.global),
    usedCount(input.tableName, keys.user),
  ]);
  return {
    used: userUsed,
    limit: userAllowance(input.role, input.channel, input.limits),
    globalRemaining: Math.max(0, input.limits[input.channel].global - globalUsed),
    resetsAt: window.endsAt,
  };
}

async function me(tableName: string, userId: string, role: AccessRole, now: Date): Promise<MeResponse> {
  const limits = allowanceLimitsFromEnvironment();
  const [voice, text] = await Promise.all([
    allowanceFor({ tableName, channel: "voice", userId, role, limits, now }),
    allowanceFor({ tableName, channel: "text", userId, role, limits, now }),
  ]);
  return meResponseSchema.parse({ role, quotas: { voice, text } });
}

export function encodeCursor(key: ItemKey): string {
  return Buffer.from(JSON.stringify({ PK: key.PK, SK: key.SK }), "utf8").toString("base64url");
}

/** Only accepts a key inside the caller's own history partition (prevents IDOR via cursor). */
export function decodeCursor(cursor: string | undefined, userId: string): ItemKey | undefined {
  if (cursor === undefined) return undefined;
  const invalid = invalidQuery("The history cursor is invalid.");
  if (!CURSOR_PATTERN.test(cursor)) throw invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid;
  const { PK, SK, ...rest } = parsed as Record<string, unknown>;
  if (
    Object.keys(rest).length > 0 ||
    PK !== `USER#${userId}` ||
    typeof SK !== "string" ||
    !SK.startsWith(HISTORY_SORT_PREFIX) ||
    SK.length > 256
  ) throw invalid;
  return { PK, SK };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  const value = Number(raw);
  if (!LIMIT_PATTERN.test(raw) || value > SESSION_LIST_MAX_LIMIT) {
    throw invalidQuery(`limit must be between 1 and ${SESSION_LIST_MAX_LIMIT}.`);
  }
  return value;
}

function toSummary(item: Record<string, unknown>) {
  const { sessionId, createdAt, channel, track, level, questionTitle, status, overallScore } = item;
  const parsed = sessionSummarySchema.safeParse({
    sessionId,
    createdAt,
    channel,
    track,
    level,
    questionTitle,
    status,
    ...(overallScore === undefined ? {} : { overallScore }),
  });
  return parsed.success ? [parsed.data] : [];
}

async function listSessions(
  tableName: string,
  userId: string,
  query: ApiGatewayV2Event["queryStringParameters"],
): Promise<SessionListResponse> {
  const limit = parseLimit(query?.limit);
  const exclusiveStartKey = decodeCursor(query?.cursor, userId);
  const response = await documentClient.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": `USER#${userId}`, ":prefix": HISTORY_SORT_PREFIX },
    ScanIndexForward: false,
    Limit: limit,
    ExclusiveStartKey: exclusiveStartKey,
  }));
  const items = (response.Items ?? []).flatMap((item) => toSummary(item));
  const last = response.LastEvaluatedKey;
  const nextCursor = typeof last?.PK === "string" && typeof last.SK === "string"
    ? encodeCursor({ PK: last.PK, SK: last.SK })
    : undefined;
  return sessionListResponseSchema.parse({ items, ...(nextCursor ? { nextCursor } : {}) });
}

async function getReport(tableName: string, userId: string, sessionId: string | undefined): Promise<ReportResponse> {
  if (!sessionId || !UUID_PATTERN.test(sessionId)) throw notFound();
  const meta = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: sessionMetaKey(sessionId),
    ConsistentRead: true,
    ProjectionExpression: "userId",
  }));
  // Another user's session is indistinguishable from a missing one.
  if ((meta.Item as { userId?: unknown } | undefined)?.userId !== userId) throw notFound();

  const stored = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: reportKey(sessionId),
    ConsistentRead: true,
  }));
  const record = stored.Item as { status?: unknown; report?: unknown; createdAt?: unknown } | undefined;
  if (!record) return reportResponseSchema.parse({ status: "pending" });
  if (record.status === "failed") return reportResponseSchema.parse({ status: "failed" });
  if (record.status !== "complete" || !record.report || typeof record.report !== "object") {
    return reportResponseSchema.parse({ status: "grading" });
  }
  return reportResponseSchema.parse({
    status: "complete",
    report: { ...(record.report as Record<string, unknown>), schemaVersion: 1 },
    gradedAt: record.createdAt,
  });
}

function resultForError(error: unknown) {
  if (!(error instanceof SafeHttpError)) return "internal_error" as const;
  if (error.statusCode === 401) return "unauthorized" as const;
  if (error.statusCode === 404) return "not_found" as const;
  return "invalid_request" as const;
}

export async function handler(event: ApiGatewayV2Event): Promise<ApiResponse> {
  const startedAt = Date.now();
  try {
    const tableName = requiredEnvironment("TABLE_NAME");
    const userId = authenticatedUserId(event);
    const now = new Date();
    let payload: unknown;
    switch (event.routeKey) {
      case "GET /v1/me":
        payload = await me(tableName, userId, authenticatedRole(event), now);
        break;
      case "GET /v1/sessions":
        payload = await listSessions(tableName, userId, event.queryStringParameters);
        break;
      case "GET /v1/sessions/{sessionId}/report":
        payload = await getReport(tableName, userId, event.pathParameters?.sessionId);
        break;
      default:
        throw new SafeHttpError(404, "route_not_found", "The requested resource was not found.");
    }
    writeSafeLog({
      ...baseLogMetadata(),
      level: "INFO",
      operation: OPERATION,
      result: "success",
      requestId: event.requestContext.requestId,
      durationMs: Date.now() - startedAt,
    });
    return jsonResponse(200, payload);
  } catch (error) {
    writeSafeLog({
      ...baseLogMetadata(),
      level: error instanceof SafeHttpError && error.statusCode < 500 ? "WARN" : "ERROR",
      operation: OPERATION,
      result: resultForError(error),
      requestId: event.requestContext.requestId,
      durationMs: Date.now() - startedAt,
    });
    return errorResponse(error);
  }
}
