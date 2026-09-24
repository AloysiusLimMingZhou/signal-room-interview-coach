import { createHash, randomUUID } from "node:crypto";
import { getUtcMonthWindow } from "../../src/lib/p1/quota";
import { sessionRequestV2Schema, sessionResponseV2Schema, type SessionResponseV2 } from "../../src/lib/p1/session-v2";
import { publicQuestion } from "../../src/lib/questions/schema";
import { selectQuestion } from "../../src/lib/questions/select-question";
import { quotaKeys, userAllowance, type AccessRole } from "../lib/access-policy";
import { rollbackSessionReservation, type QuotaReservation } from "./session-store";
import { assertV2Quota, finalizeV2Voice, recentQuestionIds, replayV2Session, reserveV2Session } from "./session-v2-store";
import { allowanceLimitsFromEnvironment, textLimitsFromEnvironment, voiceSessionMinutesFromEnvironment } from "./shared/allowances";
import { loadGeminiApiKey, provisionGeminiToken, resolvedGeminiLiveModel } from "./shared/gemini";
import { idempotencyKey, jsonResponse, SafeHttpError, type ApiGatewayV2Event } from "./shared/http";
import { baseLogMetadata, emitMetric, hashReference, writeSafeLog } from "./shared/logging";
import { questionBank } from "./shared/question-bank";
import { historySortKey } from "./shared/table-keys";

export async function createV2Session(input: { event: ApiGatewayV2Event; body: unknown; tableName: string; userId: string; role: Exclude<AccessRole, "none"> }) {
  const startedAt = Date.now();
  const { event, tableName, userId, role } = input;
  const parsed = sessionRequestV2Schema.safeParse(input.body);
  if (!parsed.success) throw new SafeHttpError(400, "invalid_request", "Choose a supported channel, track, level and language.");
  const request = parsed.data;
  const textLimits = textLimitsFromEnvironment();
  const maximumMinutes = request.channel === "voice" ? voiceSessionMinutesFromEnvironment() : textLimits.sessionMinutes;
  if (request.durationMinutes > maximumMinutes) throw new SafeHttpError(400, "duration_limit", "The requested interview duration exceeds the channel limit.");
  const key = idempotencyKey(event);
  const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const now = new Date();
  const replay = await replayV2Session(tableName, userId, key, hash, now);
  if (replay) return jsonResponse(200, replay);
  const limits = allowanceLimitsFromEnvironment();
  const reservation: QuotaReservation = {
    keys: quotaKeys(request.channel, userId, getUtcMonthWindow(now).key),
    globalLimit: limits[request.channel].global, userLimit: userAllowance(role, request.channel, limits),
  };
  await assertV2Quota(tableName, reservation, request.channel, now);
  const question = selectQuestion({ bank: questionBank, track: request.track, level: request.level, recentIds: await recentQuestionIds(tableName, userId) });
  const sessionId = randomUUID();
  const model = request.channel === "voice" ? resolvedGeminiLiveModel() : (process.env.GEMINI_TEXT_MODEL ?? "gemini-2.5-flash-lite");
  const historySk = historySortKey(now.toISOString(), sessionId);
  const common = {
    sessionId, provider: "gemini" as const, model, persistence: "aws" as const,
    question: publicQuestion(question, request.track === "coding" ? request.language : undefined),
    maxDurationMinutes: request.durationMinutes,
  };
  let response: SessionResponseV2 | undefined = request.channel === "text" ? sessionResponseV2Schema.parse({
    ...common, channel: "text", maxTurns: textLimits.maxTurns, expiresAt: new Date(now.getTime() + request.durationMinutes * 60_000).toISOString(),
  }) : undefined;
  try {
    await reserveV2Session({ tableName, sessionId, userId, role, key, hash, now, request, question, model, historySk, reservation, response });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
    const raced = await replayV2Session(tableName, userId, key, hash, now);
    if (raced) return jsonResponse(200, raced);
    await assertV2Quota(tableName, reservation, request.channel, now);
    throw new SafeHttpError(409, "idempotency_conflict", "The request conflicted with another session start.");
  }
  if (request.channel === "voice") {
    try {
      const token = await provisionGeminiToken(await loadGeminiApiKey(), request, now, request.durationMinutes + 2, question);
      response = sessionResponseV2Schema.parse({ ...common, channel: "voice", mode: "gemini", token: token.token, expiresAt: token.expiresAt,
        resume: { enabled: true, contextCompressionTriggerTokens: 25_000, slidingWindowTokens: 8_000 } });
      await finalizeV2Voice({ tableName, userId, key, hash, now, response });
    } catch (error) {
      try { await rollbackSessionReservation({ tableName, sessionId, userId, key, reservation, historySk }); } catch { /* Retain quota conservatively. */ }
      throw error;
    }
  }
  emitMetric("session_setup_ms", Date.now() - startedAt, "Milliseconds");
  writeSafeLog({ ...baseLogMetadata(), level: "INFO", operation: "session.create", result: "success", requestId: event.requestContext.requestId,
    sessionRef: hashReference(sessionId), provider: "gemini", model, durationMs: Date.now() - startedAt });
  return jsonResponse(201, sessionResponseV2Schema.parse(response));
}
