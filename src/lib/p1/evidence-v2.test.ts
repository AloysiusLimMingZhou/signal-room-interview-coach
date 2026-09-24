import { interviewEventSchema } from "./contracts";

const base = { id: "50ca3ceb-038a-4f1a-a90c-401181531de8", sessionId: "6a27e013-3d62-4828-a38d-177c0212399e", sequence: 1, occurredAt: "2026-09-24T12:00:00Z" };
describe("Phase 2 evidence compatibility", () => {
  it("accepts a bank question ID and preserves legacy UUID question IDs", () => {
    for (const questionId of ["coding.rolling-window-mode.v1", base.id]) {
      expect(interviewEventSchema.safeParse({ ...base, type: "question.started", payload: { questionId, turn: 1, prompt: "Question" } }).success).toBe(true);
    }
  });
  it.each(["java", "cpp"])("accepts %s snapshots", (language) => {
    expect(interviewEventSchema.safeParse({ ...base, type: "code.snapshot", payload: { language, revision: 1, content: "", evidenceId: "snapshot-1" } }).success).toBe(true);
  });
  it.each(["follow-up-constraint", "behavioral-probe"])("accepts a %s twist", (kind) => {
    expect(interviewEventSchema.safeParse({ ...base, type: "scenario.injected", payload: { scenarioId: "twist-1", kind, title: "Twist", prompt: "Adapt the answer.", injectedAtTurn: 1 } }).success).toBe(true);
  });
  it("accepts thirty-minute text completion and connection loss, while rejecting longer evidence", () => {
    const completion = { ...base, type: "interview.completed", payload: { reason: "connection-lost", durationMs: 30 * 60_000, finalSequence: 1, evidenceSnapshotHash: "a".repeat(64), gradingRequested: true } };
    expect(interviewEventSchema.safeParse(completion).success).toBe(true);
    expect(interviewEventSchema.safeParse({ ...completion, payload: { ...completion.payload, durationMs: 30 * 60_000 + 1 } }).success).toBe(false);
  });
});
