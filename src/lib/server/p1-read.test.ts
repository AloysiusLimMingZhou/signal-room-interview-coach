/** @jest-environment node */
jest.mock("@/lib/server/cognito-auth", () => ({ getAccessToken: jest.fn() }));

import { z } from "zod";
import { getAccessToken } from "@/lib/server/cognito-auth";
import { proxyP1Read } from "./p1-read";

const mockGetAccessToken = getAccessToken as jest.Mock;
const schema = z.object({ ok: z.literal(true) }).strict();
const originalP1Api = process.env.P1_API_URL;

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (originalP1Api === undefined) delete process.env.P1_API_URL;
  else process.env.P1_API_URL = originalP1Api;
  jest.restoreAllMocks();
  mockGetAccessToken.mockReset();
});

describe("proxyP1Read", () => {
  it("is unavailable when the protected API is not configured", async () => {
    delete process.env.P1_API_URL;
    const response = await proxyP1Read({ path: "/v1/me", schema });
    expect(response.status).toBe(404);
  });

  it("requires a signed-in session", async () => {
    process.env.P1_API_URL = "https://api.example.com";
    mockGetAccessToken.mockResolvedValue(undefined);
    expect((await proxyP1Read({ path: "/v1/me", schema })).status).toBe(401);
  });

  it("forwards a bodiless GET with the bearer token and validates the payload", async () => {
    process.env.P1_API_URL = "https://api.example.com";
    mockGetAccessToken.mockResolvedValue("access-token");
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));

    const response = await proxyP1Read({ path: "/v1/sessions", query: { limit: "5" }, schema });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.example.com/v1/sessions?limit=5");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    [403, 401],
    [404, 404],
    [400, 400],
    [500, 503],
  ])("maps upstream %i to %i without echoing upstream bodies", async (upstreamStatus, expected) => {
    process.env.P1_API_URL = "https://api.example.com";
    mockGetAccessToken.mockResolvedValue("access-token");
    jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ secret: "upstream-detail" }, { status: upstreamStatus }));

    const response = await proxyP1Read({ path: "/v1/me", schema });

    expect(response.status).toBe(expected);
    expect(await response.text()).not.toContain("upstream-detail");
  });

  it("fails closed when the upstream payload breaks the contract", async () => {
    process.env.P1_API_URL = "https://api.example.com";
    mockGetAccessToken.mockResolvedValue("access-token");
    jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, extra: "field" }));
    expect((await proxyP1Read({ path: "/v1/me", schema })).status).toBe(503);
  });

  it.each(["upstream_status", "invalid_payload", "request_failed"] as const)(
    "records safe, correlated diagnostics for %s without exposing request or response content",
    async (failure) => {
      process.env.P1_API_URL = "https://api.example.com";
      mockGetAccessToken.mockResolvedValue("private-access-token");
      const fetchSpy = jest.spyOn(globalThis, "fetch");
      if (failure === "request_failed") fetchSpy.mockRejectedValue(new Error("private transport detail"));
      else fetchSpy.mockResolvedValue(Response.json({ transcript: "private interview content" }, {
        status: failure === "upstream_status" ? 502 : 200,
      }));
      const sessionId = "0ab6d86a-2d44-4c65-bd70-1acafc3c3014";
      const response = await proxyP1Read({ path: `/v1/sessions/${sessionId}/report`, schema });

      expect(response.status).toBe(503);
      expect(console.error).toHaveBeenCalledTimes(1);
      const serialized = (console.error as jest.Mock).mock.calls[0][0] as string;
      const diagnostic = JSON.parse(serialized);
      const requestId = (fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)["X-Request-Id"];
      expect(diagnostic).toMatchObject({
        level: "error", operation: "account_read", result: "failure", requestId,
        metadata: { route: "report", failure },
      });
      expect(diagnostic.durationMs).toBeGreaterThanOrEqual(0);
      expect(diagnostic.metadata.statusCode).toBe(failure === "upstream_status" ? 502 : undefined);
      expect(serialized).not.toMatch(/private|transcript|Bearer/);
      expect(serialized).not.toContain(sessionId);
      expect(await response.text()).not.toMatch(/private|transcript|Bearer/);
    },
  );
});
