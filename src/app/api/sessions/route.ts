import { sessionListResponseSchema } from "@/lib/p1/account";
import { jsonError, proxyP1Read } from "@/lib/server/p1-read";

export const runtime = "nodejs";

const LIMIT_PATTERN = /^(?:[1-9]|[1-4][0-9]|50)$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const limit = params.get("limit");
  const cursor = params.get("cursor");
  if ((limit !== null && !LIMIT_PATTERN.test(limit)) || (cursor !== null && !CURSOR_PATTERN.test(cursor))) {
    return jsonError(400, "invalid_request", "The history request was rejected.");
  }
  return proxyP1Read({
    path: "/v1/sessions",
    query: { ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) },
    schema: sessionListResponseSchema,
  });
}
