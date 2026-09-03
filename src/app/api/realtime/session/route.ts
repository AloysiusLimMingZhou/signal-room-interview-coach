import { NextResponse } from "next/server";
import { createGeminiSession } from "@/lib/gemini-token";
import {
  sessionCreationRequestSchema,
  sessionCreationResponseSchema,
} from "@/lib/p1/contracts";
import { getAccessToken } from "@/lib/server/cognito-auth";
import { callP1Api, isP1ApiEnabled } from "@/lib/server/p1-api";
import {
  RequestValidationError,
  hasTrustedOrigin,
  readJsonBody,
} from "@/lib/server/request-security";

export const runtime = "nodejs";

const noStoreHeaders = { "Cache-Control": "no-store", Vary: "Cookie" };
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

export function localInterviewModeAllowed(nodeEnvironment = process.env.NODE_ENV): boolean {
  return nodeEnvironment !== "production";
}

function safeUpstreamError(status: number) {
  if (status === 401 || status === 403) {
    return {
      status: 401,
      body: { error: "authentication_required", message: "Sign in to start a P1 interview." },
    };
  }
  if (status === 429) {
    return {
      status: 429,
      body: { error: "quota_exhausted", message: "The monthly interview limit has been reached." },
    };
  }
  if (status === 400) {
    return {
      status: 400,
      body: { error: "invalid_request", message: "Choose a supported interview configuration." },
    };
  }
  if (status === 409) {
    return {
      status: 409,
      body: { error: "session_request_in_progress", message: "The original session request is still completing." },
    };
  }
  return {
    status: 503,
    body: { error: "application_unavailable", message: "The interview service is temporarily unavailable." },
  };
}

export async function POST(request: Request) {
  if (!hasTrustedOrigin(request)) {
    return NextResponse.json(
      { error: "invalid_origin", message: "The request origin was rejected." },
      { status: 403, headers: noStoreHeaders },
    );
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json(
      { error: "invalid_request", message: "A JSON request body is required." },
      { status: 415, headers: noStoreHeaders },
    );
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, 8 * 1024);
  } catch (error) {
    const status = error instanceof RequestValidationError ? 400 : 500;
    return NextResponse.json(
      { error: "invalid_request", message: "Choose a supported track and difficulty." },
      { status, headers: noStoreHeaders },
    );
  }

  const parsed = sessionCreationRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: "Choose a supported track and difficulty." },
      { status: 400, headers: noStoreHeaders },
    );
  }

  if (isP1ApiEnabled()) {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return NextResponse.json(
        { error: "authentication_required", message: "Sign in to start a P1 interview." },
        { status: 401, headers: noStoreHeaders },
      );
    }

    try {
      const suppliedIdempotencyKey = request.headers.get("idempotency-key");
      if (suppliedIdempotencyKey && !idempotencyKeyPattern.test(suppliedIdempotencyKey)) {
        return NextResponse.json(
          { error: "invalid_request", message: "The session request identifier was rejected." },
          { status: 400, headers: noStoreHeaders },
        );
      }
      const upstream = await callP1Api({
        path: "/v1/realtime/sessions",
        accessToken,
        body: parsed.data,
        requestId: crypto.randomUUID(),
        idempotencyKey: suppliedIdempotencyKey ?? crypto.randomUUID(),
      });
      if (!upstream.ok) {
        const safe = safeUpstreamError(upstream.status);
        return NextResponse.json(safe.body, { status: safe.status, headers: noStoreHeaders });
      }

      const provisioned = sessionCreationResponseSchema.safeParse(upstream.payload);
      if (!provisioned.success) throw new Error("Invalid P1 session response");
      return NextResponse.json(provisioned.data, { headers: noStoreHeaders });
    } catch {
      return NextResponse.json(
        { error: "application_unavailable", message: "The interview service is temporarily unavailable." },
        { status: 503, headers: noStoreHeaders },
      );
    }
  }

  if (!localInterviewModeAllowed()) {
    return NextResponse.json(
      {
        error: "p1_configuration_required",
        message: "The protected interview service is not configured.",
      },
      { status: 503, headers: noStoreHeaders },
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        sessionId: crypto.randomUUID(),
        mode: "mock",
        model: "deterministic-local-interviewer",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        maxDurationMinutes: 10,
        persistence: "local",
      },
      { headers: noStoreHeaders },
    );
  }

  try {
    const session = await createGeminiSession(apiKey, parsed.data);
    return NextResponse.json(session, { headers: noStoreHeaders });
  } catch {
    return NextResponse.json(
      {
        error: "provider_unavailable",
        message: "Gemini Live could not be provisioned. Try mock mode or retry shortly.",
      },
      { status: 503, headers: noStoreHeaders },
    );
  }
}
