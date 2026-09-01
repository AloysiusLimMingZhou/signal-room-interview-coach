import { createActor } from "xstate";
import { interviewMachine } from "../interview-machine";

describe("interview state machine", () => {
  it("completes the happy path and counts answers", () => {
    const actor = createActor(interviewMachine).start();
    actor.send({ type: "START", track: "ml-design", difficulty: "staff" });
    expect(actor.getSnapshot().matches("connecting")).toBe(true);
    actor.send({ type: "CONNECTED" });
    actor.send({ type: "ANSWER_SUBMITTED" });
    expect(actor.getSnapshot().matches({ active: "responding" })).toBe(true);
    expect(actor.getSnapshot().context.answerCount).toBe(1);
    actor.send({ type: "INTERVIEWER_FINISHED" });
    actor.send({ type: "FINISH" });
    actor.send({ type: "GRADED" });
    expect(actor.getSnapshot().matches("completed")).toBe(true);
  });

  it("preserves a safe error and permits retry", () => {
    const actor = createActor(interviewMachine).start();
    actor.send({ type: "START", track: "algorithms", difficulty: "mid" });
    actor.send({ type: "FAIL", message: "Provider unavailable" });
    expect(actor.getSnapshot().matches("failed")).toBe(true);
    expect(actor.getSnapshot().context.error).toBe("Provider unavailable");
    actor.send({ type: "RETRY" });
    expect(actor.getSnapshot().matches("setup")).toBe(true);
  });
});
