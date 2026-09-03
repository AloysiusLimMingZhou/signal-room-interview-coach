import { NextResponse } from "next/server";
import {
  AUTH_STATE_COOKIE,
  AUTH_VERIFIER_COOKIE,
  createCodeChallenge,
  getCognitoWebConfig,
  randomBase64Url,
} from "@/lib/server/cognito-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const transientCookie = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 10 * 60,
  path: "/api/auth",
};

export async function GET(request: Request) {
  try {
    const config = getCognitoWebConfig(request.url);
    const state = randomBase64Url();
    const verifier = randomBase64Url(48);
    const challenge = await createCodeChallenge(verifier);
    const authorizeUrl = new URL("/oauth2/authorize", config.domainOrigin);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: "openid email profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    const response = NextResponse.redirect(authorizeUrl);
    response.cookies.set({ name: AUTH_STATE_COOKIE, value: state, ...transientCookie });
    response.cookies.set({ name: AUTH_VERIFIER_COOKIE, value: verifier, ...transientCookie });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json(
      { error: "authentication_unavailable", message: "Sign-in is not configured yet." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
