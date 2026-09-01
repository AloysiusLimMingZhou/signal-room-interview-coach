import {
  buildEvidenceScorecard,
  followUpPrompt,
  initialPrompt,
  makeTranscript,
} from "../interview";

describe("interview domain", () => {
  it("calibrates the first prompt for staff candidates", () => {
    expect(initialPrompt("system-design", "staff")).toContain("staff level");
    expect(initialPrompt("ml-design", "senior")).not.toContain("staff level");
  });

  it("cycles deterministic follow-up prompts", () => {
    expect(followUpPrompt("algorithms", 1)).toContain("complexity");
    expect(followUpPrompt("algorithms", 4)).toContain("complexity");
  });

  it("builds a scorecard whose references exist in the evidence snapshot", () => {
    const transcript = [
      makeTranscript("interviewer", "Design it", 1),
      makeTranscript("candidate", "I would begin with requirements and latency targets.", 2),
      makeTranscript("candidate", "Then I would partition by tenant and monitor lag.", 3),
    ];
    const scores = buildEvidenceScorecard(
      transcript,
      "export function example() { return 'a concrete artifact longer than eighty characters for evidence'; }",
      [{ id: "node-1", label: "API", kind: "service" }, { id: "node-2", label: "DB", kind: "data" }],
    );

    expect(scores).toHaveLength(3);
    expect(scores.every((score) => score.score >= 1 && score.score <= 5)).toBe(true);
    expect(scores.flatMap((score) => score.evidenceReferences)).toContain("evidence:event-2");
    expect(scores.flatMap((score) => score.evidenceReferences)).toContain("evidence:canvas-final");
  });

  it("reports missing candidate evidence transparently", () => {
    const scores = buildEvidenceScorecard([], "", []);
    expect(scores[0].evidenceReferences).toEqual([]);
    expect(scores[0].feedback).toContain("No candidate response");
  });
});
