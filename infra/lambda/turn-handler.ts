import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { textTurnRequestSchema, textTurnResponseSchema, type TextTurnRequest } from "../../src/lib/p1/session-v2";
import { textLimitsFromEnvironment } from "./shared/allowances";
import { requiredEnvironment } from "./shared/aws-clients";
import { loadGeminiApiKey } from "./shared/gemini";
import { authenticatedRole, authenticatedUserId, errorResponse, jsonResponse, parseJsonRequest, SafeHttpError, type ApiGatewayV2Event } from "./shared/http";
import { baseLogMetadata, hashReference, writeSafeLog } from "./shared/logging";
import { getQuestion } from "./shared/question-bank";
import { generateTextTurn } from "./shared/text-gemini";
import { busyTurn, claimTextTurn, commitTextTurn, failTextTurn, loadTextHistory, readTextSession, replayTextTurn, type TextSessionState } from "./turn-store";

function validateTurn(state: TextSessionState, request: TextTurnRequest, maxTurns: number, now: Date): void {
  if (state.status !== "created" || Date.parse(state.sessionEndsAt) <= now.getTime() || state.textTurnCount >= maxTurns || state.textGenerationCount >= maxTurns) {
    throw new SafeHttpError(409, "session_closed", "The text interview has reached its limit. Complete the interview to receive feedback.");
  }
  if ((state.textLeaseUntil ?? 0) >= now.getTime()) throw busyTurn();
  if ((state.textTurnCount === 0) !== (request.kind === "start")) throw new SafeHttpError(409, "invalid_turn_order", "Start the interview once before sending candidate turns.");
  if ((request.kind === "twist" && state.twistUsed) || (request.kind === "time-warning" && state.timeWarningUsed)) throw busyTurn();
  if (request.kind === "time-warning" && Date.parse(state.sessionEndsAt) - now.getTime() > 60_000) {
    throw new SafeHttpError(400, "invalid_control", "The wrap-up warning is available in the final minute.");
  }
  if (request.workspace && (state.track !== "coding" || request.workspace.language !== state.language)) {
    throw new SafeHttpError(400, "invalid_workspace", "The workspace must match the session's track and language.");
  }
}

export async function handler(event: ApiGatewayV2Event) {
  const startedAt = Date.now(); let sessionRef: string | undefined;
  try {
    const userId = authenticatedUserId(event);
    if (authenticatedRole(event) === "none") throw new SafeHttpError(403, "account_not_enabled", "This account has not been enabled. Access is invite-only.");
    const id = z.string().uuid().safeParse(event.pathParameters?.sessionId);
    if (!id.success) throw new SafeHttpError(404, "session_not_found", "The interview session was not found.");
    const parsed = textTurnRequestSchema.safeParse(parseJsonRequest(event, 96 * 1_024));
    if (!parsed.success) throw new SafeHttpError(400, "invalid_turn", "The turn does not match the supported schema.");
    const request = parsed.data; const limits = textLimitsFromEnvironment();
    if (request.kind === "candidate" && request.text.length > limits.maxTurnChars) throw new SafeHttpError(400, "turn_too_long", "The candidate turn exceeds the character limit.");
    const tableName = requiredEnvironment("TABLE_NAME"); const sessionId = id.data; sessionRef = hashReference(sessionId);
    const identity = { tableName, sessionId, userId, turnId: request.turnId, hash: createHash("sha256").update(JSON.stringify(request)).digest("hex") };
    const state = await readTextSession(tableName, sessionId, userId);
    const replay = await replayTextTurn(identity);
    if (replay) return jsonResponse(200, replay);
    const now = new Date(); validateTurn(state, request, limits.maxTurns, now);
    const question = getQuestion(state.questionId);
    if (question.track !== state.track || !question.levels.includes(state.level)) throw new Error("Stored question configuration is inconsistent.");
    const lease = { ...identity, leaseId: randomUUID(), now, state, maxTurns: limits.maxTurns, request };
    try { await claimTextTurn(lease); } catch (error) {
      if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
      const raced = await replayTextTurn(identity);
      if (raced) return jsonResponse(200, raced);
      throw busyTurn();
    }
    let response;
    try {
      const history = await loadTextHistory(tableName, sessionId);
      const generated = await generateTextTurn({ apiKey: await loadGeminiApiKey(), question, level: state.level, language: state.language, model: state.model, history, request });
      response = textTurnResponseSchema.parse({ ...generated, turnId: request.turnId, turnIndex: state.textTurnCount + 1,
        ...(request.kind === "twist" ? { twist: question.twist } : {}) });
    } catch {
      try { await failTextTurn(lease); } catch { /* Expiring lease and consumed attempt retain the conservative budget. */ }
      throw new SafeHttpError(502, "text_provider_unavailable", "The interviewer could not respond. Retry this turn shortly.");
    }
    try { await commitTextTurn(lease, response); } catch {
      const saved = await replayTextTurn(identity);
      if (saved) return jsonResponse(200, saved);
      throw busyTurn(); // Do not refund or release an uncertain commit.
    }
    writeSafeLog({ ...baseLogMetadata(), operation: "text.turn", level: "INFO", result: "success", sessionRef, requestId: event.requestContext.requestId, durationMs: Date.now() - startedAt });
    return jsonResponse(200, response);
  } catch (error) {
    const serverFailure = !(error instanceof SafeHttpError) || error.statusCode >= 500;
    writeSafeLog({ ...baseLogMetadata(), operation: "text.turn", level: serverFailure ? "ERROR" : "WARN",
      result: error instanceof SafeHttpError && error.statusCode === 502 ? "provider_unavailable" : serverFailure ? "internal_error" : "invalid_request",
      sessionRef, requestId: event.requestContext.requestId, durationMs: Date.now() - startedAt });
    return errorResponse(error);
  }
}
