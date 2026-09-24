/** @jest-environment node */
jest.mock("@/lib/server/cognito-auth", () => ({ getAccessToken: jest.fn() }));
import { getAccessToken } from "@/lib/server/cognito-auth";
import { POST } from "./route";
const id = "6a27e013-3d62-4828-a38d-177c0212399e";
const turnId = "50ca3ceb-038a-4f1a-a90c-401181531de8";
const context = { params: Promise.resolve({ id }) };
function request(body: unknown = { turnId, kind: "start" }, origin = "https://app.example.com") {
  return new Request(`https://app.example.com/api/sessions/${id}/turn`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}
const originalApi = process.env.P1_API_URL; const originalOrigin = process.env.APP_ORIGIN;
beforeEach(() => {
  process.env.P1_API_URL = "https://api.example.com"; process.env.APP_ORIGIN = "https://app.example.com";
  (getAccessToken as jest.Mock).mockResolvedValue("mock-access-token");
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks(); jest.clearAllMocks();
  if (originalApi === undefined) delete process.env.P1_API_URL; else process.env.P1_API_URL = originalApi;
  if (originalOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = originalOrigin;
});
it("validates and forwards the protected turn, preserving a no-store response", async () => {
  const saved = { turnId, turnIndex: 1, interviewerText: "Opening question", usage: { inputTokens: 1, outputTokens: 1 } };
  const fetcher = jest.spyOn(global, "fetch").mockResolvedValue(Response.json(saved));
  const response = await POST(request(), context);
  expect(response.status).toBe(200); expect(await response.json()).toEqual(saved);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(String(fetcher.mock.calls[0][0])).toBe(`https://api.example.com/v1/sessions/${id}/turn`);
  expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
});
it("rejects missing auth, cross-origin requests, forged history and invalid IDs before fetching", async () => {
  const fetcher = jest.spyOn(global, "fetch").mockRejectedValue(new Error("Unexpected fetch"));
  expect((await POST(request(undefined, "https://evil.example"), context)).status).toBe(403);
  expect((await POST(request({ turnId, kind: "start", history: [] }), context)).status).toBe(400);
  expect((await POST(request(), { params: Promise.resolve({ id: "../../me" }) })).status).toBe(404);
  (getAccessToken as jest.Mock).mockResolvedValue(undefined);
  expect((await POST(request(), context)).status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
});
it("rejects malformed provider output and never echoes upstream error text", async () => {
  const fetcher = jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ secret: "upstream-private-text" }));
  expect((await POST(request(), context)).status).toBe(503);
  fetcher.mockResolvedValue(Response.json({ error: "session_closed", message: "upstream-private-text" }, { status: 409 }));
  const response = await POST(request(), context);
  expect(response.status).toBe(409);
  const text = await response.text(); expect(text).toContain("session_closed"); expect(text).not.toContain("upstream-private-text");
});
