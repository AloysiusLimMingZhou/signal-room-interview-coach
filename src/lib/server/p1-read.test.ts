/** @jest-environment node */
jest.mock("@/lib/server/cognito-auth", () => ({ getAccessToken: jest.fn() }));

import { z } from "zod";
import { getAccessToken } from "@/lib/server/cognito-auth";
import { proxyP1Read } from "./p1-read";

const mockGetAccessToken = getAccessToken as jest.Mock;
const schema = z.object({ ok: z.literal(true) }).strict();
const originalP1Api = process.env.P1_API_URL;

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
});
