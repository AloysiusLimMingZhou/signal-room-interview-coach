/** @jest-environment node */

import { normalizeP1AppendResponse, POST } from "./route";

const sessionId = "2ddbb7bb-2751-45a4-8b32-30a74ee8bb37";

function validBatch() {
  return {
    sessionId,
    baseSequence: 0,
    events: [
      {
        id: "fd43beab-272b-4036-b09b-fc5daf35903e",
        sessionId,
        sequence: 1,
        occurredAt: "2026-09-01T00:00:00.000Z",
        type: "transcript.final",
        payload: {
          speaker: "candidate",
          text: "I would start with the availability target.",
          evidenceId: "evidence:event-1",
          startMs: 0,
          endMs: 2_000,
        },
      },
    ],
  };
}

describe("POST /api/interview-events", () => {
  const originalP1Api = process.env.P1_API_URL;

  afterEach(() => {
    if (originalP1Api === undefined) delete process.env.P1_API_URL;
    else process.env.P1_API_URL = originalP1Api;
  });

  it("accepts a valid batch as a local no-op when P1 is disabled", async () => {
    delete process.env.P1_API_URL;
    const response = await POST(new Request("http://localhost/api/interview-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify(validBatch()),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ accepted: 1, persistence: "local" });
  });

  it("rejects an untrusted origin before parsing sensitive content", async () => {
    const response = await POST(new Request("http://localhost/api/interview-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify(validBatch()),
    }));

    expect(response.status).toBe(403);
  });

  it("rejects event payloads outside the strict schema", async () => {
    const batch = validBatch();
    (batch.events[0].payload as Record<string, unknown>).apiKey = "must-not-be-accepted";
    const response = await POST(new Request("http://localhost/api/interview-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify(batch),
    }));

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("must-not-be-accepted");
  });

  it("normalizes the Lambda append contract for the browser", () => {
    expect(normalizeP1AppendResponse({
      acceptedEventIds: ["fd43beab-272b-4036-b09b-fc5daf35903e"],
      duplicateEventIds: [],
      lastSequence: 1,
    })).toEqual({ accepted: 1, duplicates: [], lastSequence: 1, persistence: "aws" });

    expect(() => normalizeP1AppendResponse({ accepted: 1 })).toThrow();
  });
});
