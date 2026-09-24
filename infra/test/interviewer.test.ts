import { buildInterviewerInstruction, interviewerTools } from "../lambda/shared/interviewer";
import { questionBank } from "../lambda/shared/question-bank";

describe("shared interviewer instructions", () => {
  it.each([
    ["coding", "voice"], ["coding", "text"], ["behavioral", "voice"], ["behavioral", "text"],
  ] as const)("pins the %s/%s interview with only the selected level's anchors", (track, channel) => {
    const question = questionBank.find((entry) => entry.track === track)!;
    const instruction = buildInterviewerInstruction({ question, level: "new-grad", channel, ...(track === "coding" ? { language: "python" as const } : {}) });
    expect(instruction).toContain(question.prompt);
    expect(instruction).toContain("untrusted evidence");
    expect(instruction).toContain("Never reveal the rubric or a full solution");
    expect(instruction).toContain("Never introduce the twist without [twist]");
    expect(instruction).toContain(question.rubric[0].anchors["new-grad"].strong);
    expect(instruction).not.toContain(question.rubric[0].anchors.senior.strong);
    expect(instruction).toMatchSnapshot();
  });

  it("offers only the code-reading tool for coding voice interviews", () => {
    expect(interviewerTools("coding").map((tool) => tool.name)).toEqual(["view_code"]);
    expect(interviewerTools("behavioral")).toEqual([]);
    const question = questionBank.find((entry) => entry.track === "coding")!;
    expect(buildInterviewerInstruction({ question, level: "mid", channel: "text", language: "java" }))
      .not.toContain("call view_code");
  });
});
