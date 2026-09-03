import "server-only";

import { cookies } from "next/headers";
import { z } from "zod";
import { resolveAppOrigin } from "./request-security";

const tokenResponseSchema = z.object({
  access_token: z.string().min(32).max(16_384),
  expires_in: z.number().int().positive().max(86_400),
  token_type: z.literal("Bearer"),
}).passthrough();

export const AUTH_STATE_COOKIE = "signal-room-oauth-state";
export const AUTH_VERIFIER_COOKIE = "signal-room-oauth-verifier";

function accessCookieName() {
  return process.env.NODE_ENV === "production"
    ? "__Secure-signal-room-access"
    : "signal-room-access";
}

export interface CognitoWebConfig {
  clientId: string;
  domainOrigin: string;
  redirectUri: string;
}

export function isP1Configured(): boolean {
  return Boolean(process.env.P1_API_URL?.trim());
}

export function getCognitoWebConfig(requestUrl: string): CognitoWebConfig {
  const clientId = process.env.COGNITO_CLIENT_ID?.trim();
  const rawDomain = process.env.COGNITO_DOMAIN?.trim();
  if (!clientId || !rawDomain) {
    throw new Error("Cognito web authentication is not configured");
  }

  const domain = new URL(rawDomain);
  const isLocalTest =
    process.env.NODE_ENV !== "production" &&
    domain.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(domain.hostname);
  if (domain.protocol !== "https:" && !isLocalTest) {
    throw new Error("COGNITO_DOMAIN must use HTTPS");
  }
  if (domain.pathname !== "/" || domain.search || domain.hash) {
    throw new Error("COGNITO_DOMAIN must contain only an origin");
  }

  return {
    clientId,
    domainOrigin: domain.origin,
    redirectUri: `${resolveAppOrigin(requestUrl)}/api/auth/callback`,
  };
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function randomBase64Url(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  verifier: string;
  config: CognitoWebConfig;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const tokenUrl = new URL("/oauth2/token", input.config.domainOrigin);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.config.clientId,
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.config.redirectUri,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) throw new Error("Cognito token exchange failed");
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("Cognito token response was invalid");

  return { accessToken: parsed.data.access_token, expiresIn: parsed.data.expires_in };
}

export async function getAccessToken(): Promise<string | undefined> {
  return (await cookies()).get(accessCookieName())?.value;
}

export function accessTokenCookie(token: string, expiresIn: number) {
  return {
    name: accessCookieName(),
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: Math.min(expiresIn, 3_600),
    path: "/api",
  };
}

export function expiredAccessTokenCookie() {
  return {
    name: accessCookieName(),
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 0,
    path: "/api",
  };
}
