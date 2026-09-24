import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { serializeStructuredLog } from "@/lib/p1/logging";
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

  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  const recordFailure = (failure: "upstream_status" | "invalid_payload" | "request_failed", statusCode?: number) => {
    console.error(serializeStructuredLog({
      level: "error",
      operation: "account_read",
      result: "failure",
      environment: process.env.NODE_ENV === "production" ? "production" : "development",
      requestId,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      metadata: {
        route: input.path === "/v1/me" ? "account" : input.path === "/v1/sessions" ? "history" : "report",
        failure,
        ...(statusCode === undefined ? {} : { statusCode }),
      },
    }));
  };

  try {
    const upstream = await callP1Api({
      method: "GET",
      path: input.path,
      query: input.query,
      accessToken,
      requestId,
    });
    if (upstream.status === 401 || upstream.status === 403) return signInRequired();
    if (upstream.status === 404) return jsonError(404, "not_found", "The requested resource was not found.");
    if (upstream.status === 400) return jsonError(400, "invalid_request", "The request was rejected.");
    if (!upstream.ok) {
      recordFailure("upstream_status", upstream.status);
      return unavailable();
    }

    const parsed = input.schema.safeParse(upstream.payload);
    if (!parsed.success) {
      recordFailure("invalid_payload");
      return unavailable();
    }
    return NextResponse.json(parsed.data, { headers: noStoreHeaders });
  } catch {
    recordFailure("request_failed");
    return unavailable();
  }
}
