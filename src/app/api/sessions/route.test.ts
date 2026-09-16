/** @jest-environment node */
jest.mock("@/lib/server/p1-read", () => {
  const actual = jest.requireActual("@/lib/server/p1-read");
  return { ...actual, proxyP1Read: jest.fn(async () => new Response(null, { status: 204 })) };
});

import { proxyP1Read } from "@/lib/server/p1-read";
import { GET } from "./route";

const mockProxy = proxyP1Read as jest.Mock;

describe("GET /api/sessions", () => {
  beforeEach(() => mockProxy.mockClear());

  it.each(["0", "51", "1.5", "x"])("rejects limit=%s before calling upstream", async (limit) => {
    const response = await GET(new Request(`http://localhost/api/sessions?limit=${limit}`));
    expect(response.status).toBe(400);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("rejects a cursor outside the base64url alphabet", async () => {
    const response = await GET(new Request("http://localhost/api/sessions?cursor=abc%2Fdef"));
    expect(response.status).toBe(400);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("forwards only validated query parameters", async () => {
    await GET(new Request("http://localhost/api/sessions?limit=20&cursor=abc_DEF-1&extra=drop"));
    expect(mockProxy).toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1/sessions",
      query: { limit: "20", cursor: "abc_DEF-1" },
    }));
  });
});
