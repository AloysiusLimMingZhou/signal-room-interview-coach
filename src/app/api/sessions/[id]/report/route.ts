import { reportResponseSchema } from "@/lib/p1/account";
import { jsonError, proxyP1Read } from "@/lib/server/p1-read";

export const runtime = "nodejs";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!SESSION_ID_PATTERN.test(id)) {
    return jsonError(404, "not_found", "The requested resource was not found.");
  }
  return proxyP1Read({ path: `/v1/sessions/${id.toLowerCase()}/report`, schema: reportResponseSchema });
}
