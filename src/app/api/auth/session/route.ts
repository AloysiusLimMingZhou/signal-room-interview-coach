import { NextResponse } from "next/server";
import { getAccessToken, isP1Configured } from "@/lib/server/cognito-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const accessToken = await getAccessToken();
  return NextResponse.json(
    { p1Enabled: isP1Configured(), authenticated: Boolean(accessToken) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
