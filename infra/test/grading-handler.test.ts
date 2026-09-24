/** @jest-environment node */
jest.mock("../lambda/shared/aws-clients", () => {
  const actual = jest.requireActual("../lambda/shared/aws-clients");
  return { ...actual, documentClient: { send: jest.fn() } };
});
jest.mock("../lambda/shared/gemini", () => ({
  gradeEvidence: jest.fn(),
  loadGeminiApiKey: jest.fn().mockResolvedValue("server-side-key"),
}));

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { handler, isFinalDeliveryAttempt } from "../lambda/grading-handler";
import { documentClient } from "../lambda/shared/aws-clients";
import { gradeEvidence } from "../lambda/shared/gemini";

const mockSend = documentClient.send as jest.Mock;
const mockGradeEvidence = gradeEvidence as jest.Mock;
const userId = "user-123";
const sessionId = "6a27e013-3d62-4828-a38d-177c0212399e";
const completionId = "50ca3ceb-038a-4f1a-a90c-401181531de8";
const transcriptId = "0e8f2a4c-6b1d-4c3e-9f5a-1b2c3d4e5f60";
const historySk = `SESSION#2026-09-02T00:00:00.000Z#${sessionId}`;

const storedEvents = [
  {
    eventId: transcriptId,
    sessionId,
    sequence: 1,
    occurredAt: "2026-09-02T00:01:00.000Z",
    eventType: "transcript.final",
    payload: { speaker: "candidate", text: "I would use a hash map.", evidenceId: "evidence:voice-1", startMs: 0, endMs: 1_000 },
  },
  {
    eventId: completionId,
    sessionId,
    sequence: 2,
    occurredAt: "2026-09-02T00:02:00.000Z",
    eventType: "interview.completed",
    payload: {
      reason: "user-ended",
      durationMs: 120_000,
      finalSequence: 2,
      evidenceSnapshotHash: "a".repeat(64),
      gradingRequested: true,
    },
  },
];

function scoreAt(score: number) {
  return {
    competency: `competency-${score}`,
    score,
    confidence: 0.8,
    evidenceReferences: [{ eventId: transcriptId, rationale: "Named a data structure." }],
    feedback: "State the complexity.",
    retryPrompt: "Explain the time complexity.",
  };
}

function sqsEvent(receiveCount: string) {
  return {
    Records: [{
      messageId: "message-1",
      body: JSON.stringify({ sessionId, userId, completionEventId: completionId }),
      attributes: { ApproximateReceiveCount: receiveCount },
    }],
  };
}

function sentCommands() {
  return mockSend.mock.calls.map(([command]) => command);
}

beforeEach(() => {
  process.env.TABLE_NAME = "sessions";
  delete process.env.GRADING_MAX_RECEIVE_COUNT;
  mockSend.mockReset();
  mockGradeEvidence.mockReset();
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof GetCommand) {
      return command.input.Key?.SK === "META"
        ? { Item: { userId, track: "algorithms", difficulty: "mid", historySk } }
        : {};
    }
    if (command instanceof QueryCommand) return { Items: storedEvents };
    return {};
  });
});

describe("grading outcomes", () => {
  it("records graded status and the overall score on the history item", async () => {
    mockGradeEvidence.mockResolvedValue({ summary: "Solid.", scores: [scoreAt(4), scoreAt(3)] });

    const result = await handler(sqsEvent("1"));

    expect(result.batchItemFailures).toEqual([]);
    const update = sentCommands().find((command) => command instanceof UpdateCommand) as UpdateCommand;
    expect(update.input.Key).toEqual({ PK: `USER#${userId}`, SK: historySk });
    expect(update.input.ExpressionAttributeValues).toEqual({ ":status": "graded", ":score": 3.5 });
  });

  it("marks the report and history failed on the final delivery attempt", async () => {
    mockGradeEvidence.mockRejectedValue(new Error("Gemini grading request failed."));

    const result = await handler(sqsEvent("3"));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "message-1" }]);
    const failedReport = sentCommands().find(
      (command) => command instanceof PutCommand && command.input.Item?.status === "failed",
    ) as PutCommand;
    expect(failedReport.input.Item).toMatchObject({ PK: `SESSION#${sessionId}`, SK: "REPORT#P1#v1" });
    const update = sentCommands().find((command) => command instanceof UpdateCommand) as UpdateCommand;
    expect(update.input.ExpressionAttributeValues).toEqual({ ":status": "failed" });
  });

  it("leaves earlier attempts retryable without marking failure", async () => {
    mockGradeEvidence.mockRejectedValue(new Error("Gemini grading request failed."));

    const result = await handler(sqsEvent("1"));

    expect(result.batchItemFailures).toHaveLength(1);
    expect(sentCommands().some((command) => command instanceof PutCommand && command.input.Item?.status === "failed"))
      .toBe(false);
  });
});

describe("final delivery detection", () => {
  it("compares the SQS receive count with the redrive limit", () => {
    expect(isFinalDeliveryAttempt({ messageId: "m", body: "{}", attributes: { ApproximateReceiveCount: "3" } }, 3)).toBe(true);
    expect(isFinalDeliveryAttempt({ messageId: "m", body: "{}", attributes: { ApproximateReceiveCount: "2" } }, 3)).toBe(false);
    expect(isFinalDeliveryAttempt({ messageId: "m", body: "{}" }, 3)).toBe(false);
  });
});
