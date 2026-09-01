/** @jest-environment node */

import { POST } from "./route";

describe("POST /api/realtime/session", () => {
  const originalKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    jest.restoreAllMocks();
  });

  it("returns mock mode when no API key is configured", async () => {
    delete process.env.GEMINI_API_KEY;
    const request = new Request("http://localhost/api/realtime/session", {
      method: "POST",
      body: JSON.stringify({
        track: "system-design",
        difficulty: "senior",
        providerPreference: "gemini",
      }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload.mode).toBe("mock");
    expect(payload.token).toBeUndefined();
  });

  it("rejects an unsupported request", async () => {
    const request = new Request("http://localhost/api/realtime/session", {
      method: "POST",
      body: JSON.stringify({ track: "trivia", difficulty: "easy" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("does not echo the standard key when provisioning fails", async () => {
    process.env.GEMINI_API_KEY = "should-never-leak";
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream secret", { status: 500 }));
    const request = new Request("http://localhost/api/realtime/session", {
      method: "POST",
      body: JSON.stringify({
        track: "ml-design",
        difficulty: "staff",
        providerPreference: "gemini",
      }),
    });

    const response = await POST(request);
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
    const request = new Request("http://localhost/api/realtime/session", {
      method: "POST",
      body: JSON.stringify({
        track: "system-design",
        difficulty: "senior",
        providerPreference: "gemini",
      }),
    });

    const response = await POST(request);
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
  });
});
