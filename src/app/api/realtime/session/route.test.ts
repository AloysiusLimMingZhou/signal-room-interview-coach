/** @jest-environment node */

jest.mock("@/lib/server/cognito-auth", () => ({ getAccessToken: jest.fn() }));
import { getAccessToken } from "@/lib/server/cognito-auth";
import { localInterviewModeAllowed, POST } from "./route";

describe("POST /api/realtime/session", () => {
  const originalKey = process.env.GEMINI_API_KEY;
  const originalP1Api = process.env.P1_API_URL;

  function request(body: unknown, headers: Record<string, string> = {}) {
    return new Request("http://localhost/api/realtime/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalP1Api === undefined) delete process.env.P1_API_URL;
    else process.env.P1_API_URL = originalP1Api;
    jest.restoreAllMocks();
  });

  it("returns mock mode when no API key is configured", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.P1_API_URL;
    const response = await POST(request({
        track: "system-design",
        difficulty: "senior",
        providerPreference: "gemini",
        durationMinutes: 10,
      }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload.mode).toBe("mock");
    expect(payload.token).toBeUndefined();
  });

  it("keeps unauthenticated local provider modes out of production", () => {
    expect(localInterviewModeAllowed("development")).toBe(true);
    expect(localInterviewModeAllowed("test")).toBe(true);
    expect(localInterviewModeAllowed("production")).toBe(false);
  });

  it("rejects an unsupported request", async () => {
    const response = await POST(request({ track: "trivia", difficulty: "easy" }));
    expect(response.status).toBe(400);
  });

  it("rejects cross-origin token provisioning", async () => {
    const response = await POST(request({
      track: "system-design",
      difficulty: "senior",
      providerPreference: "gemini",
    }, { Origin: "https://attacker.example" }));
    expect(response.status).toBe(403);
  });

  it("does not echo the standard key when provisioning fails", async () => {
    process.env.GEMINI_API_KEY = "should-never-leak";
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream secret", { status: 500 }));
    const response = await POST(request({
        track: "ml-design",
        difficulty: "staff",
        providerPreference: "gemini",
        durationMinutes: 10,
      }));
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).not.toContain("should-never-leak");
    expect(body).not.toContain("upstream secret");
  });

  it("returns only the constrained ephemeral token when provisioning succeeds", async () => {
    process.env.GEMINI_API_KEY = "standard-key-must-stay-server-side";
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ name: "authTokens/ephemeral-example" }),
    );
    const response = await POST(request({
        track: "system-design",
        difficulty: "senior",
        providerPreference: "gemini",
        durationMinutes: 10,
      }));
    const body = await response.text();
    const requestBody = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));

    expect(response.status).toBe(200);
    expect(body).toContain("authTokens/ephemeral-example");
    expect(body).not.toContain("standard-key-must-stay-server-side");
    expect(requestBody.uses).toBe(1);
    expect(requestBody.liveConnectConstraints.model).toBe("models/gemini-3.1-flash-live-preview");
    expect(requestBody.liveConnectConstraints.config.sessionResumption).toEqual({});
    expect(requestBody.liveConnectConstraints.config.contextWindowCompression).toEqual({
      triggerTokens: 25_000,
      slidingWindow: { targetTokens: 8_000 },
    });
    expect(JSON.parse(body)).toMatchObject({
      provider: "gemini",
      maxDurationMinutes: 10,
      persistence: "local",
    });
  });

  it("tells a signed-in account without a group that access is invite-only", async () => {
    process.env.P1_API_URL = "https://api.example.com";
    (getAccessToken as jest.Mock).mockResolvedValue("access-token");
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "account_not_enabled" }, { status: 403 }),
    );
    const response = await POST(request({
      track: "algorithms",
      difficulty: "mid",
      providerPreference: "gemini",
      durationMinutes: 10,
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "account_not_enabled" });
  });

  it("proxies a v2 text session and rejects private or mismatched upstream descriptors", async () => {
    process.env.P1_API_URL = "https://api.example.com";
    (getAccessToken as jest.Mock).mockResolvedValue("mock-access-token");
    const body = { channel: "text", track: "coding", level: "mid", providerPreference: "gemini" };
    const saved = { channel: "text", sessionId: "6a27e013-3d62-4828-a38d-177c0212399e", provider: "gemini", model: "gemini-2.5-flash-lite", persistence: "aws", maxDurationMinutes: 30, maxTurns: 40, expiresAt: "2026-09-24T12:30:00Z", question: { id: "coding.rolling-window-mode.v1", title: "Rolling window", prompt: "Find the mode.", language: "python", starterCode: "" } };
    const fetcher = jest.spyOn(global, "fetch").mockResolvedValue(Response.json(saved));
    const result = await POST(request(body));
    expect(result.status).toBe(200); expect(await result.json()).toEqual(saved);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ channel: "text", language: "python", durationMinutes: 30 });
    fetcher.mockResolvedValue(Response.json({ ...saved, question: { ...saved.question, rubric: "private" } }));
    expect((await POST(request(body))).status).toBe(503);
    fetcher.mockResolvedValue(Response.json({ ...saved, question: { ...saved.question, language: "java" } }));
    expect((await POST(request(body))).status).toBe(503);
  });

  it("requires the protected API for v2 sessions instead of falling into local key mode", async () => {
    delete process.env.P1_API_URL;
    process.env.GEMINI_API_KEY = "mock-local-key";
    const fetcher = jest.spyOn(global, "fetch").mockRejectedValue(new Error("Unexpected provider call"));
    expect((await POST(request({ channel: "text", track: "behavioral", level: "mid", providerPreference: "gemini" }))).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
