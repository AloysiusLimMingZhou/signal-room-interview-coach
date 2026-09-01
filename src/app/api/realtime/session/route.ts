import { NextResponse } from "next/server";
import { z } from "zod";
import { createGeminiSession } from "@/lib/gemini-token";

export const runtime = "nodejs";

const requestSchema = z.object({
  track: z.enum(["system-design", "ml-design", "algorithms"]),
  difficulty: z.enum(["mid", "senior", "staff"]),
  providerPreference: z.literal("gemini"),
});

const noStoreHeaders = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: "Choose a supported track and difficulty." },
      { status: 400, headers: noStoreHeaders },
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
