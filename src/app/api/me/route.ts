import { meResponseSchema } from "@/lib/p1/account";
import { proxyP1Read } from "@/lib/server/p1-read";

export const runtime = "nodejs";

export async function GET() {
  return proxyP1Read({ path: "/v1/me", schema: meResponseSchema });
}
