import { NextResponse } from "next/server";
import { z } from "zod";
import {
  appendEventBatchSchema,
  MAX_EVENT_BATCH_BYTES,
  MAX_EVENT_BATCH_SIZE,
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
const upstreamAppendResponseSchema = z.object({
  acceptedEventIds: z.array(z.string().uuid()).max(MAX_EVENT_BATCH_SIZE),
  duplicateEventIds: z.array(z.string().uuid()).max(MAX_EVENT_BATCH_SIZE),
  lastSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export function normalizeP1AppendResponse(value: unknown) {
  const parsed = upstreamAppendResponseSchema.parse(value);
  return {
    accepted: parsed.acceptedEventIds.length,
    duplicates: parsed.duplicateEventIds,
    lastSequence: parsed.lastSequence,
    persistence: "aws" as const,
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
    body = await readJsonBody(request, MAX_EVENT_BATCH_BYTES);
  } catch (error) {
    const status = error instanceof RequestValidationError ? 400 : 500;
    return NextResponse.json(
      { error: "invalid_request", message: "The event batch was rejected." },
      { status, headers: noStoreHeaders },
    );
  }

  const parsed = appendEventBatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: "The event batch was rejected." },
      { status: 400, headers: noStoreHeaders },
    );
  }

  if (!isP1ApiEnabled()) {
    return NextResponse.json(
      { accepted: parsed.data.events.length, duplicates: [], persistence: "local" },
      { status: 202, headers: noStoreHeaders },
    );
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return NextResponse.json(
      { error: "authentication_required", message: "Sign in to sync interview evidence." },
      { status: 401, headers: noStoreHeaders },
    );
  }

  try {
    const upstream = await callP1Api({
      path: "/v1/interview-events",
      accessToken,
      body: parsed.data,
      requestId: crypto.randomUUID(),
    });
    if (!upstream.ok) {
      const status = upstream.status === 409 ? 409 : upstream.status === 401 ? 401 : 503;
      return NextResponse.json(
        {
          error: status === 409 ? "idempotency_conflict" : status === 401 ? "authentication_required" : "persistence_unavailable",
          message: status === 409 ? "An event sequence conflict was detected." : "Interview evidence could not be synchronized.",
        },
        { status, headers: noStoreHeaders },
      );
    }

    return NextResponse.json(normalizeP1AppendResponse(upstream.payload), {
      status: upstream.status,
      headers: noStoreHeaders,
    });
  } catch {
    return NextResponse.json(
      { error: "persistence_unavailable", message: "Interview evidence could not be synchronized." },
      { status: 503, headers: noStoreHeaders },
    );
  }
}
