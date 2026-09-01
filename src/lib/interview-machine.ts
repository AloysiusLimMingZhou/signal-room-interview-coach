import { assign, setup } from "xstate";
import type { InterviewDifficulty, InterviewTrack } from "./realtime/types";

export interface InterviewMachineContext {
  track: InterviewTrack;
  difficulty: InterviewDifficulty;
  answerCount: number;
  error?: string;
}

export type InterviewMachineEvent =
  | { type: "START"; track: InterviewTrack; difficulty: InterviewDifficulty }
  | { type: "CONNECTED" }
  | { type: "ANSWER_SUBMITTED" }
  | { type: "INTERVIEWER_STARTED" }
  | { type: "INTERVIEWER_FINISHED" }
  | { type: "FINISH" }
  | { type: "GRADED" }
  | { type: "FAIL"; message: string }
  | { type: "RETRY" };

export const interviewMachine = setup({
  types: {
    context: {} as InterviewMachineContext,
    events: {} as InterviewMachineEvent,
  },
}).createMachine({
  id: "interview",
  initial: "setup",
  context: {
    track: "system-design",
    difficulty: "senior",
    answerCount: 0,
  },
  states: {
    setup: {
      on: {
        START: {
          target: "connecting",
          actions: assign(({ event }) => ({
            track: event.track,
            difficulty: event.difficulty,
            answerCount: 0,
            error: undefined,
          })),
        },
      },
    },
    connecting: {
      on: {
        CONNECTED: "active.listening",
        FAIL: {
          target: "failed",
          actions: assign(({ event }) => ({ error: event.message })),
        },
      },
    },
    active: {
      initial: "listening",
      on: {
        FINISH: "grading",
        FAIL: {
          target: "#interview.failed",
          actions: assign(({ event }) => ({ error: event.message })),
        },
      },
      states: {
        listening: {
          on: {
            ANSWER_SUBMITTED: {
              target: "responding",
              actions: assign(({ context }) => ({ answerCount: context.answerCount + 1 })),
            },
            INTERVIEWER_STARTED: "responding",
          },
        },
        responding: {
          on: {
            INTERVIEWER_FINISHED: "listening",
          },
        },
      },
    },
    grading: {
      on: { GRADED: "completed" },
    },
    completed: { type: "final" },
    failed: {
      on: { RETRY: "setup" },
    },
  },
});
