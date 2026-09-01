import type { InterviewDifficulty, InterviewTrack } from "./realtime/types";

export interface TranscriptItem {
  id: string;
  speaker: "interviewer" | "candidate" | "system";
  text: string;
  occurredAt: string;
  evidenceId: string;
}

export interface DesignNode {
  id: string;
  label: string;
  kind: "client" | "service" | "data" | "queue";
}

export interface EvidenceScore {
  competency: string;
  score: number;
  confidence: number;
  evidenceReferences: string[];
  feedback: string;
  retryPrompt: string;
}

const prompts: Record<InterviewTrack, string> = {
  "system-design":
    "Design a globally available collaborative document editor. Start with requirements, then walk me through the core architecture and its trade-offs.",
  "ml-design":
    "Design a production recommendation system for a fast-growing marketplace. Start with the objective, data, and offline evaluation strategy.",
  algorithms:
    "You receive a stream of events with timestamps. Design an algorithm that returns the most frequent event type in a rolling five-minute window.",
};

const followUps: Record<InterviewTrack, string[]> = {
  "system-design": [
    "Which consistency guarantees matter most here, and where would you deliberately accept eventual consistency?",
    "How would your design behave when one region loses connectivity for twenty minutes?",
    "What would you measure to prove the system is healthy for users?",
  ],
  "ml-design": [
    "How will you prevent training-serving skew and detect it quickly?",
    "What cold-start strategy would you use for both new users and new inventory?",
    "How would you respond if click-through rate rose while long-term retention fell?",
  ],
  algorithms: [
    "State the time and space complexity, including the cost of evicting stale events.",
    "How would your solution change if events arrive late or out of order?",
    "Which invariants would you test with property-based tests?",
  ],
};

export const scenarioByTrack: Record<InterviewTrack, string> = {
  "system-design": "Scenario update: traffic jumps 10× and a privacy rule requires EU data residency.",
  "ml-design": "Scenario update: a seasonal launch causes severe feature drift and labels arrive seven days late.",
  algorithms: "Scenario update: events can arrive up to two minutes late and duplicate IDs are possible.",
};

export function initialPrompt(track: InterviewTrack, difficulty: InterviewDifficulty): string {
  const calibration = difficulty === "staff" ? " At staff level, make your decision framework explicit." : "";
  return `${prompts[track]}${calibration}`;
}

export function followUpPrompt(track: InterviewTrack, answerCount: number): string {
  const options = followUps[track];
  return options[Math.max(0, answerCount - 1) % options.length];
}

export function makeTranscript(
  speaker: TranscriptItem["speaker"],
  text: string,
  sequence: number,
): TranscriptItem {
  return {
    id: `event-${sequence}`,
    speaker,
    text,
    occurredAt: new Date().toISOString(),
    evidenceId: `evidence:event-${sequence}`,
  };
}

export function buildEvidenceScorecard(
  transcript: TranscriptItem[],
  code: string,
  nodes: DesignNode[],
): EvidenceScore[] {
  const candidate = transcript.filter((item) => item.speaker === "candidate");
  const candidateEvidence = candidate.map((item) => item.evidenceId);
  const artifactEvidence = [
    ...(code.trim().length > 80 ? ["evidence:code-final"] : []),
    ...(nodes.length > 1 ? ["evidence:canvas-final"] : []),
  ];
  const depth = Math.min(5, 2 + candidate.length + (artifactEvidence.length > 0 ? 1 : 0));

  return [
    {
      competency: "Problem framing",
      score: Math.min(5, 2 + candidate.length),
      confidence: candidate.length > 1 ? 0.82 : 0.62,
      evidenceReferences: candidateEvidence.slice(0, 2),
      feedback: candidate.length
        ? "You established a direction; make assumptions and success measures explicit earlier."
        : "No candidate response was captured, so framing could not be assessed.",
      retryPrompt: "Restate the problem with three functional requirements and two constraints.",
    },
    {
      competency: "Technical depth",
      score: depth,
      confidence: artifactEvidence.length ? 0.86 : 0.66,
      evidenceReferences: [...candidateEvidence.slice(-2), ...artifactEvidence],
      feedback: artifactEvidence.length
        ? "Your answer is supported by a concrete artifact; quantify the main bottleneck next."
        : "Add a concrete code or architecture artifact to make the trade-offs testable.",
      retryPrompt: "Identify the first scaling limit and show how your design changes around it.",
    },
    {
      competency: "Communication",
      score: Math.min(5, 2 + Math.ceil(candidate.length / 2)),
      confidence: 0.76,
      evidenceReferences: candidateEvidence,
      feedback: "Use a short headline before each deeper explanation to keep the answer easy to follow.",
      retryPrompt: "Give the same answer in a two-minute, top-down structure.",
    },
  ];
}
