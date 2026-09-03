import "server-only";

import type { InterviewDifficulty, InterviewTrack, RealtimeSession } from "./realtime/types";

const TOKEN_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
const TOKEN_LIFETIME_MS = 12 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 10_000;

interface GeminiTokenResponse {
  name?: unknown;
}

export async function createGeminiSession(
  apiKey: string,
  interview: { track: InterviewTrack; difficulty: InterviewDifficulty },
): Promise<RealtimeSession> {
  const model = process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL;
  const now = Date.now();
  const expireTime = new Date(now + TOKEN_LIFETIME_MS).toISOString();
  const newSessionExpireTime = new Date(now + 60 * 1000).toISOString();

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      uses: 1,
      expireTime,
      newSessionExpireTime,
      liveConnectConstraints: {
        model: `models/${model}`,
        config: {
          responseModalities: ["AUDIO"],
          systemInstruction: {
            parts: [{
              text: `You are a concise technical interviewer running a ${interview.difficulty} ${interview.track} practice interview. Ask one question at a time, probe trade-offs, acknowledge artifacts described by the candidate, and never issue a hire/no-hire decision.`,
            }],
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          sessionResumption: {},
          contextWindowCompression: {
            triggerTokens: 25_000,
            slidingWindow: { targetTokens: 8_000 },
          },
        },
      },
    }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Gemini token provisioning failed with status ${response.status}`);
  }

  const token = (await response.json()) as GeminiTokenResponse;
  if (typeof token.name !== "string" || token.name.length < 10 || token.name.length > 8_192) {
    throw new Error("Gemini token provisioning returned no token");
  }

  return {
    sessionId: crypto.randomUUID(),
    mode: "gemini",
    provider: "gemini",
    model,
    token: token.name,
    expiresAt: expireTime,
    maxDurationMinutes: 10,
    persistence: "local",
    resume: {
      enabled: true,
      contextCompressionTriggerTokens: 25_000,
      slidingWindowTokens: 8_000,
    },
  };
}
