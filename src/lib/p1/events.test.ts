import type { InterviewEvent } from "./contracts";
import {
  fingerprintInterviewEvent,
  validateIdempotentAppend,
  type ExistingEventReference,
} from "./events";

function event(sequence: number, idSuffix = sequence): InterviewEvent {
  return {
    id: `123e4567-e89b-42d3-a456-${String(idSuffix).padStart(12, "0")}`,
    sessionId: "223e4567-e89b-42d3-a456-426614174000",
    sequence,
    occurredAt: "2026-09-01T00:00:00.000Z",
    type: "question.started",
    payload: {
      questionId: `323e4567-e89b-42d3-a456-${String(sequence).padStart(12, "0")}`,
      turn: sequence,
      prompt: `Question ${sequence}`,
    },
  };
}

function reference(value: InterviewEvent): ExistingEventReference {
  return {
    id: value.id,
    sequence: value.sequence,
    fingerprint: fingerprintInterviewEvent(value),
  };
}

describe("idempotent event validation", () => {
  it("accepts a contiguous append", () => {
    const events = [event(3), event(4)];

    expect(validateIdempotentAppend({ events, lastSequence: 2, existing: [] })).toEqual({
      accepted: events,
      duplicateIds: [],
    });
  });

  it("treats an exact retry as idempotent and accepts the new suffix", () => {
    const retried = event(2);
    const next = event(3);

    expect(
      validateIdempotentAppend({
        events: [retried, next],
        lastSequence: 2,
        existing: [reference(retried)],
      }),
    ).toEqual({ accepted: [next], duplicateIds: [retried.id] });
  });

  it("rejects an event ID reused with different content", () => {
    const stored = event(2);
    const changed = {
      ...stored,
      payload: { ...stored.payload, prompt: "Tampered question" },
    } as InterviewEvent;

    expect(
      validateIdempotentAppend({
        events: [changed],
        lastSequence: 2,
        existing: [reference(stored)],
      }).conflict?.kind,
    ).toBe("duplicate-id-mismatch");
  });

  it("rejects sequence collisions", () => {
    const stored = event(2);
    expect(
      validateIdempotentAppend({
        events: [event(2, 99)],
        lastSequence: 2,
        existing: [reference(stored)],
      }).conflict?.kind,
    ).toBe("sequence-already-used");
  });

  it("rejects unseen gaps and out-of-order evidence", () => {
    expect(
      validateIdempotentAppend({ events: [event(4)], lastSequence: 2, existing: [] }).conflict?.kind,
    ).toBe("sequence-gap");
    expect(
      validateIdempotentAppend({ events: [event(4), event(3)], lastSequence: 2, existing: [] })
        .conflict?.kind,
    ).toBe("sequence-gap");
  });
});
