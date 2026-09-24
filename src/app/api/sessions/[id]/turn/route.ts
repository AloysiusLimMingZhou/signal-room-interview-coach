import { NextResponse } from "next/server";
import { z } from "zod";
import { textTurnRequestSchema, textTurnResponseSchema } from "@/lib/p1/session-v2";
import { getAccessToken } from "@/lib/server/cognito-auth";
import { callP1Api, isP1ApiEnabled } from "@/lib/server/p1-api";
import { hasTrustedOrigin, readJsonBody } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const maxDuration = 30;
const headers = { "Cache-Control": "no-store", Vary: "Cookie" };
const error = (status: number, code: string, message: string) => NextResponse.json({ error: code, message }, { status, headers });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!hasTrustedOrigin(request)) return error(403, "invalid_origin", "The request origin was rejected.");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return error(415, "invalid_request", "Send the turn as JSON.");
  const id = z.string().uuid().safeParse((await context.params).id);
  if (!id.success) return error(404, "session_not_found", "The interview session was not found.");
  let body;
  try { body = textTurnRequestSchema.safeParse(await readJsonBody(request, 96 * 1_024)); } catch {
    return error(400, "invalid_turn", "The turn does not match the supported schema.");
  }
  if (!body.success) return error(400, "invalid_turn", "The turn does not match the supported schema.");
  const requestId = crypto.randomUUID(); const startedAt = Date.now();
  try {
    if (!isP1ApiEnabled()) return error(503, "application_unavailable", "The interview service is not configured.");
    const accessToken = await getAccessToken();
    if (!accessToken) return error(401, "authentication_required", "Sign in to continue the interview.");
    const upstream = await callP1Api({ path: `/v1/sessions/${id.data}/turn`, accessToken, body: body.data, requestId, timeoutMs: 25_000 });
    if (!upstream.ok) {
      if (upstream.status === 401) return error(401, "authentication_required", "Sign in to continue the interview.");
      if (upstream.status === 403) return error(403, "account_not_enabled", "This account is not enabled for interviews.");
      if (upstream.status === 404) return error(404, "session_not_found", "The interview session was not found.");
      if (upstream.status === 400) return error(400, "invalid_turn", "The turn was rejected. Check the text and workspace.");
      if (upstream.status === 409) {
        // Select fixed local copy from one recognized code; never echo upstream messages.
        const closed = z.object({ error: z.literal("session_closed") }).safeParse(upstream.payload).success;
        return closed ? error(409, "session_closed", "The interview reached its limit. Complete it to receive feedback.")
          : error(409, "turn_conflict", "Another turn is running or this request changed. Retry shortly.");
      }
      if (upstream.status === 502) return error(502, "text_provider_unavailable", "The interviewer could not respond. Retry this turn shortly.");
      throw new Error("Upstream request failed.");
    }
    const parsed = textTurnResponseSchema.safeParse(upstream.payload);
    if (!parsed.success || parsed.data.turnId !== body.data.turnId) throw new Error("Invalid turn response.");
    return NextResponse.json(parsed.data, { headers });
  } catch {
    console.error(JSON.stringify({ operation: "p1.turn", requestId, result: "request_failed", durationMs: Date.now() - startedAt }));
    return error(503, "application_unavailable", "The interview service is temporarily unavailable.");
  }
}
