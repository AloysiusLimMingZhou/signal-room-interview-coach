import {
  MAX_EVENT_BATCH_BYTES,
  appendEventBatchSchema,
  sessionCreationRequestSchema,
  sessionCreationResponseSchema,
  type InterviewEvent,
} from "./contracts";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";

function questionEvent(sequence: number): InterviewEvent {
  return {
    id: `123e4567-e89b-42d3-a456-${String(sequence).padStart(12, "0")}`,
    sessionId,
    sequence,
    occurredAt: "2026-09-01T00:00:00.000Z",
    type: "question.started",
    payload: {
      questionId: `223e4567-e89b-42d3-a456-${String(sequence).padStart(12, "0")}`,
      turn: sequence,
      prompt: "Design a resilient queue.",
    },
  };
}

describe("P1 request contracts", () => {
  it("defaults a valid Gemini pilot session to ten minutes", () => {
    expect(
      sessionCreationRequestSchema.parse({
        track: "system-design",
        difficulty: "senior",
        providerPreference: "gemini",
      }),
    ).toEqual({
      track: "system-design",
      difficulty: "senior",
      providerPreference: "gemini",
      durationMinutes: 10,
    });
  });

  it.each([
    {
      track: "system-design",
      difficulty: "senior",
      providerPreference: "gemini",
      durationMinutes: 11,
    },
    {
      track: "system-design",
      difficulty: "senior",
      providerPreference: "gemini",
      durationMinutes: 10,
      apiKey: "attacker-controlled",
    },
    {
      track: "<script>alert(1)</script>",
      difficulty: "senior",
      providerPreference: "gemini",
      durationMinutes: 10,
    },
  ])("rejects malicious or out-of-policy session input", (input) => {
    expect(sessionCreationRequestSchema.safeParse(input).success).toBe(false);
  });

  it("keeps the provisioned session compatible with the browser adapter", () => {
    expect(
      sessionCreationResponseSchema.parse({
        sessionId,
        mode: "gemini",
        provider: "gemini",
        model: "gemini-3.1-flash-live-preview",
        token: "ephemeral-token-value",
        expiresAt: "2026-09-01T00:01:00.000Z",
        maxDurationMinutes: 10,
        persistence: "aws",
        resume: {
          enabled: true,
          contextCompressionTriggerTokens: 25_000,
          slidingWindowTokens: 8_000,
        },
      }),
    ).toMatchObject({ mode: "gemini", provider: "gemini", maxDurationMinutes: 10 });
  });

  it("accepts a strict contiguous append-only event batch", () => {
    const parsed = appendEventBatchSchema.parse({
      sessionId,
      baseSequence: 0,
      events: [questionEvent(1), questionEvent(2)],
    });

    expect(parsed.events).toHaveLength(2);
  });

  it("rejects duplicate IDs, gaps, cross-session events, and injected fields", () => {
    const duplicate = questionEvent(2);
    duplicate.id = questionEvent(1).id;
    duplicate.sessionId = "323e4567-e89b-42d3-a456-426614174000";
    (duplicate.payload as Record<string, unknown>).apiKey = "do-not-accept";

    const result = appendEventBatchSchema.safeParse({
      sessionId,
      baseSequence: 0,
      events: [questionEvent(1), duplicate],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
        expect.arrayContaining(["events.1.id", "events.1.sessionId", "events.1.payload"]),
      );
    }
  });

  it("rejects oversized artifact payloads and encoded batches", () => {
    const event = {
      ...questionEvent(1),
      type: "code.patch" as const,
      payload: {
        language: "typescript" as const,
        patch: "x".repeat(65_537),
        baseRevision: 0,
        revision: 1,
      },
    };

    expect(
      appendEventBatchSchema.safeParse({ sessionId, baseSequence: 0, events: [event] }).success,
    ).toBe(false);

    const nearLimitEvents = Array.from({ length: 5 }, (_, index) => ({
      ...event,
      id: `423e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`,
      sequence: index + 1,
      payload: { ...event.payload, patch: "x".repeat(60_000), revision: index + 1 },
    }));
    const input = { sessionId, baseSequence: 0, events: nearLimitEvents };

    expect(JSON.stringify(input).length).toBeGreaterThan(MAX_EVENT_BATCH_BYTES);
    expect(appendEventBatchSchema.safeParse(input).success).toBe(false);
  });

  it("accepts bounded final artifact snapshots and completion for grading", () => {
    const events: InterviewEvent[] = [
      {
        ...questionEvent(1),
        type: "code.snapshot",
        payload: {
          language: "typescript",
          content: "export const answer = 42;",
          revision: 3,
          evidenceId: "evidence:code-final",
        },
      },
      {
        ...questionEvent(2),
        type: "canvas.snapshot",
        payload: {
          revision: 4,
          nodes: [{ id: "api", label: "API", kind: "service", x: 10, y: 20 }],
          edges: [],
          evidenceId: "evidence:canvas-final",
        },
      },
      {
        ...questionEvent(3),
        type: "scenario.injected",
        payload: {
          scenarioId: "regional-failure",
          kind: "component-failure",
          title: "Region unavailable",
          prompt: "The primary region is unavailable. Adapt the design.",
          injectedAtTurn: 3,
        },
      },
      {
        ...questionEvent(4),
        type: "interview.completed",
        payload: {
          reason: "time-limit",
          durationMs: 600_000,
          finalSequence: 4,
          evidenceSnapshotHash: "a".repeat(64),
          gradingRequested: true,
        },
      },
    ];

    expect(appendEventBatchSchema.safeParse({ sessionId, baseSequence: 0, events }).success).toBe(
      true,
    );
  });

  it("requires exactly one terminal completion with a matching final sequence", () => {
    const completion = {
      ...questionEvent(1),
      type: "interview.completed" as const,
      payload: {
        reason: "user-ended" as const,
        durationMs: 1_000,
        finalSequence: 2,
        evidenceSnapshotHash: "b".repeat(64),
        gradingRequested: true,
      },
    };

    expect(appendEventBatchSchema.safeParse({
      sessionId,
      baseSequence: 0,
      events: [completion, questionEvent(2)],
    }).success).toBe(false);
  });
});
