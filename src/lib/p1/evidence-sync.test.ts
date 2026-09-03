import type { AppendEventBatch } from "./contracts";
import { EvidenceSyncError, syncInterviewEventBatch } from "./evidence-sync";

const batch = {
  sessionId: "6a27e013-3d62-4828-a38d-177c0212399e",
  baseSequence: 0,
  events: [{
    id: "50ca3ceb-038a-4f1a-a90c-401181531de8",
    sessionId: "6a27e013-3d62-4828-a38d-177c0212399e",
    sequence: 1,
    occurredAt: "2026-09-02T00:00:00.000Z",
    type: "question.started",
    payload: {
      questionId: "95f1f62c-f7a1-41c2-b13e-73537560ab4b",
      turn: 1,
      prompt: "Design a resilient service.",
    },
  }],
} satisfies AppendEventBatch;

function response(status: number, retryAfter?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(retryAfter ? { "Retry-After": retryAfter } : {}),
  } as Response;
}

describe("syncInterviewEventBatch", () => {
  it("retries the same idempotent payload after transient failures", async () => {
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(202));
    const sleep = jest.fn(async () => undefined);

    await expect(syncInterviewEventBatch(batch, { fetchImpl, sleep })).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map((call) => call[1]?.body)).toEqual([
      JSON.stringify(batch),
      JSON.stringify(batch),
      JSON.stringify(batch),
    ]);
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty("keepalive");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent sequence conflict", async () => {
    const fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(response(409));

    await expect(syncInterviewEventBatch(batch, { fetchImpl })).rejects.toMatchObject({
      status: 409,
      retryable: false,
    } satisfies Partial<EvidenceSyncError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds Retry-After and the total attempt count", async () => {
    const fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(response(429, "300"));
    const sleep = jest.fn(async () => undefined);

    await expect(syncInterviewEventBatch(batch, {
      fetchImpl,
      attempts: 99,
      sleep,
    })).rejects.toBeInstanceOf(EvidenceSyncError);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenLastCalledWith(2_000);
  });
});
