import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { getAccessToken } from "@/lib/server/cognito-auth";
import { callP1Api, isP1ApiEnabled, type P1ApiPath } from "@/lib/server/p1-api";

const noStoreHeaders = { "Cache-Control": "no-store", Vary: "Cookie" };

export function jsonError(status: number, error: string, message: string): NextResponse {
  return NextResponse.json({ error, message }, { status, headers: noStoreHeaders });
}

const unavailable = () => jsonError(503, "application_unavailable", "The interview service is temporarily unavailable.");
const signInRequired = () => jsonError(401, "authentication_required", "Sign in to continue.");

/**
 * Proxies an authenticated read to the P1 API. GET reads need no Origin check: the
 * access cookie is SameSite=Lax and scoped to /api, and responses carry no CORS headers.
 */
export async function proxyP1Read<T>(input: {
  path: P1ApiPath;
  query?: Record<string, string>;
  schema: z.ZodType<T>;
}): Promise<NextResponse> {
  if (!isP1ApiEnabled()) {
    return jsonError(404, "not_available", "Account features require the protected interview service.");
  }
  const accessToken = await getAccessToken();
  if (!accessToken) return signInRequired();

  try {
    const upstream = await callP1Api({
      method: "GET",
      path: input.path,
      query: input.query,
      accessToken,
      requestId: crypto.randomUUID(),
    });
    if (upstream.status === 401 || upstream.status === 403) return signInRequired();
    if (upstream.status === 404) return jsonError(404, "not_found", "The requested resource was not found.");
    if (upstream.status === 400) return jsonError(400, "invalid_request", "The request was rejected.");
    if (!upstream.ok) return unavailable();

    const parsed = input.schema.safeParse(upstream.payload);
    if (!parsed.success) return unavailable();
    return NextResponse.json(parsed.data, { headers: noStoreHeaders });
  } catch {
    return unavailable();
  }
}
