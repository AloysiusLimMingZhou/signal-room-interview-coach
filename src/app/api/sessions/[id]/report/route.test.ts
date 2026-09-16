/** @jest-environment node */
jest.mock("@/lib/server/p1-read", () => {
  const actual = jest.requireActual("@/lib/server/p1-read");
  return { ...actual, proxyP1Read: jest.fn(async () => new Response(null, { status: 204 })) };
});

import { proxyP1Read } from "@/lib/server/p1-read";
import { GET } from "./route";

const mockProxy = proxyP1Read as jest.Mock;
const context = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/sessions/[id]/report", () => {
  beforeEach(() => mockProxy.mockClear());

  it("rejects a malformed id without calling upstream", async () => {
    const response = await GET(new Request("http://localhost/api/sessions/x/report"), context("..%2Fme"));
    expect(response.status).toBe(404);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("normalizes the id to lowercase for the upstream path", async () => {
    await GET(new Request("http://localhost/api/sessions/x/report"), context("6A27E013-3D62-4828-A38D-177C0212399E"));
    expect(mockProxy).toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1/sessions/6a27e013-3d62-4828-a38d-177c0212399e/report",
    }));
  });
});
