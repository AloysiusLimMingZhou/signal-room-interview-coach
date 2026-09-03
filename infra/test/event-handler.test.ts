/** @jest-environment node */
import type { AppendEventBatch } from "../lambda/shared/contracts";
import {
  PILOT_MAX_APPEND_GRACE_SECONDS,
  PILOT_MAX_SESSION_EVENTS,
  assertSessionAcceptsNewEvents,
  gradingMessagesForPersistedEvents,
} from "../lambda/event-handler";
import { SafeHttpError } from "../lambda/shared/http";

const completionId = "50ca3ceb-038a-4f1a-a90c-401181531de8";
const sessionId = "6a27e013-3d62-4828-a38d-177c0212399e";

function completionBatch(): AppendEventBatch {
  return {
    sessionId,
    baseSequence: 0,
    events: [{
      id: completionId,
      sessionId,
      sequence: 1,
      occurredAt: "2026-09-02T00:00:00.000Z",
      type: "interview.completed",
      payload: {
        reason: "user-ended",
        durationMs: 60_000,
        finalSequence: 1,
        evidenceSnapshotHash: "a".repeat(64),
        gradingRequested: true,
      },
    }],
  };
}

describe("grading message creation", () => {
  it("enqueues grading only for a newly accepted completion event", () => {
    expect(
      gradingMessagesForPersistedEvents(completionBatch(), "user-123", new Set([completionId])),
    ).toEqual([{ sessionId, userId: "user-123", completionEventId: completionId }]);
  });

  it("re-enqueues an exact persisted completion so a failed SQS send can recover", () => {
    expect(
      gradingMessagesForPersistedEvents(completionBatch(), "user-123", new Set([completionId])),
    ).toEqual([{ sessionId, userId: "user-123", completionEventId: completionId }]);
  });

  it("never dispatches a completion that was not persisted", () => {
    expect(gradingMessagesForPersistedEvents(completionBatch(), "user-123", new Set())).toEqual([]);
  });
});

describe("session evidence budget", () => {
  const now = new Date("2026-09-02T00:10:00.000Z");

  it("accepts bounded evidence during the append grace window", () => {
    expect(() => assertSessionAcceptsNewEvents({
      state: {
        status: "created",
        eventCount: PILOT_MAX_SESSION_EVENTS - 1,
        sessionEndsAt: "2026-09-02T00:09:00.000Z",
      },
      acceptedEventCount: 1,
      maxSessionEvents: PILOT_MAX_SESSION_EVENTS,
      appendGraceSeconds: PILOT_MAX_APPEND_GRACE_SECONDS,
      now,
    })).not.toThrow();
  });

  it.each([
    {
      state: { status: "completed" as const, eventCount: 10, sessionEndsAt: "2026-09-02T00:10:00.000Z" },
      acceptedEventCount: 1,
      errorCode: "session_closed",
    },
    {
      state: { status: "created" as const, eventCount: 10, sessionEndsAt: "2026-09-02T00:07:59.000Z" },
      acceptedEventCount: 1,
      errorCode: "session_expired",
    },
    {
      state: {
        status: "created" as const,
        eventCount: PILOT_MAX_SESSION_EVENTS,
        sessionEndsAt: "2026-09-02T00:10:00.000Z",
      },
      acceptedEventCount: 1,
      errorCode: "session_event_limit",
    },
  ])("rejects new evidence when $errorCode", ({ state, acceptedEventCount, errorCode }) => {
    try {
      assertSessionAcceptsNewEvents({
        state,
        acceptedEventCount,
        maxSessionEvents: PILOT_MAX_SESSION_EVENTS,
        appendGraceSeconds: PILOT_MAX_APPEND_GRACE_SECONDS,
        now,
      });
      throw new Error("Expected the session evidence gate to reject the append.");
    } catch (error) {
      expect(error).toBeInstanceOf(SafeHttpError);
      expect(error).toMatchObject({ errorCode });
    }
  });
});
