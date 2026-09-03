import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_STATE_COOKIE,
  AUTH_VERIFIER_COOKIE,
  accessTokenCookie,
  constantTimeEqual,
  exchangeAuthorizationCode,
  getCognitoWebConfig,
} from "@/lib/server/cognito-auth";
import { resolveAppOrigin } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clearTransientCookies(response: NextResponse) {
  response.cookies.set({ name: AUTH_STATE_COOKIE, value: "", maxAge: 0, path: "/api/auth" });
  response.cookies.set({ name: AUTH_VERIFIER_COOKIE, value: "", maxAge: 0, path: "/api/auth" });
}
export async function GET(request: NextRequest) {
  let appOrigin: string;
  try {
    appOrigin = resolveAppOrigin(request.url);
  } catch {
    return NextResponse.json(
      { error: "authentication_unavailable", message: "Sign-in is not configured yet." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const failure = () => {
    const response = NextResponse.redirect(new URL("/?auth=failed", appOrigin));
    clearTransientCookies(response);
    response.headers.set("Cache-Control", "no-store");
    return response;
  };

  const code = request.nextUrl.searchParams.get("code");
  const returnedState = request.nextUrl.searchParams.get("state");
  const expectedState = request.cookies.get(AUTH_STATE_COOKIE)?.value;
  const verifier = request.cookies.get(AUTH_VERIFIER_COOKIE)?.value;
  if (!code || code.length > 4_096 || !returnedState || !expectedState || !verifier) return failure();
  if (!constantTimeEqual(returnedState, expectedState)) return failure();

  try {
    const config = getCognitoWebConfig(request.url);
    const token = await exchangeAuthorizationCode({ code, verifier, config });
    const response = NextResponse.redirect(new URL("/?auth=success", appOrigin));
    response.cookies.set(accessTokenCookie(token.accessToken, token.expiresIn));
    clearTransientCookies(response);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return failure();
  }
}
