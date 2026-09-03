/** @jest-environment node */

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
});
