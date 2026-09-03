import { NextResponse } from "next/server";
import { expiredAccessTokenCookie } from "@/lib/server/cognito-auth";
import { hasTrustedOrigin } from "@/lib/server/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!hasTrustedOrigin(request)) {
    return NextResponse.json(
      { error: "invalid_origin", message: "The request origin was rejected." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const response = NextResponse.json({ signedOut: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(expiredAccessTokenCookie());
  return response;
}
