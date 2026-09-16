import { NextResponse } from "next/server";
import { getAccessToken, isP1Configured } from "@/lib/server/cognito-auth";
import { resolveContactUrl } from "@/lib/server/contact-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const accessToken = await getAccessToken();
  const contactUrl = resolveContactUrl();
  return NextResponse.json(
    { p1Enabled: isP1Configured(), authenticated: Boolean(accessToken), ...(contactUrl ? { contactUrl } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
