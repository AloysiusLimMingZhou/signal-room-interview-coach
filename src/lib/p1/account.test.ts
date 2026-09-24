import {
  meResponseSchema,
  reportResponseSchema,
  sessionListResponseSchema,
  sessionSummarySchema,
} from "./account";
import { overallScore, type GradingReport } from "./report";

const allowance = { used: 1, limit: 10, globalRemaining: 7, resetsAt: "2026-10-01T00:00:00.000Z" };
const eventId = "0e8f2a4c-6b1d-4c3e-9f5a-1b2c3d4e5f60";

function report(scores: number[]): GradingReport {
  return {
    summary: "Clear approach with a missing complexity analysis.",
    scores: scores.map((score, index) => ({
      competency: `competency-${index}`,
      score,
      confidence: 0.8,
      evidenceReferences: [{ eventId, rationale: "Stated the approach." }],
      feedback: "Quantify the bottleneck.",
      retryPrompt: "Explain the complexity again.",
    })),
  };
}

describe("account contracts", () => {
  it("accepts a well-formed /v1/me response and rejects unknown keys", () => {
    const valid = { role: "guest", quotas: { voice: allowance, text: { ...allowance, limit: 5 } } };
    expect(meResponseSchema.parse(valid)).toEqual(valid);
    expect(() => meResponseSchema.parse({ ...valid, isAdmin: true })).toThrow();
    expect(() => meResponseSchema.parse({ ...valid, role: "admin" })).toThrow();
  });

  it("bounds session summaries and list pages", () => {
    const summary = {
      sessionId: "6a27e013-3d62-4828-a38d-177c0212399e",
      createdAt: "2026-09-15T10:00:00.000Z",
      channel: "voice",
      track: "algorithms",
      level: "mid",
      questionTitle: "Algorithms",
      status: "graded",
      overallScore: 3.5,
    };
    expect(sessionSummarySchema.parse(summary)).toEqual(summary);
    expect(() => sessionSummarySchema.parse({ ...summary, overallScore: 6 })).toThrow();
    expect(() => sessionSummarySchema.parse({ ...summary, PK: "USER#x" })).toThrow();
    expect(() => sessionListResponseSchema.parse({ items: [], nextCursor: "not a cursor!" })).toThrow();
  });

  it("requires schemaVersion on stored v1 reports", () => {
    const complete = { status: "complete", report: { ...report([4]), schemaVersion: 1 }, gradedAt: "2026-09-15T10:05:00.000Z" };
    expect(reportResponseSchema.parse(complete).status).toBe("complete");
    expect(() => reportResponseSchema.parse({ status: "complete", report: report([4]) })).toThrow();
    expect(reportResponseSchema.parse({ status: "pending" })).toEqual({ status: "pending" });
  });

  it("computes the overall score as a one-decimal mean", () => {
    expect(overallScore(report([4, 3, 5]))).toBe(4);
    expect(overallScore(report([4, 3]))).toBe(3.5);
    expect(overallScore(report([3, 3, 4]))).toBe(3.3);
  });
});
