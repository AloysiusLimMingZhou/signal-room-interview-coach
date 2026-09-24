/** @jest-environment node */
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../lambda/shared/aws-clients";
import { handler } from "../lambda/event-handler";

jest.mock("../lambda/shared/aws-clients", () => ({
  documentClient: { send: jest.fn() }, sqsClient: { send: jest.fn() },
  requiredEnvironment: (key: string) => key === "TABLE_NAME" ? "sessions" : "queue",
  positiveIntegerEnvironment: (_key: string, fallback: number) => fallback,
}));
jest.mock("../lambda/shared/logging", () => ({ baseLogMetadata: () => ({}), emitMetric: jest.fn(), hashReference: () => "ref", writeSafeLog: jest.fn() }));

const sessionId = "6a27e013-3d62-4828-a38d-177c0212399e";
const send = jest.mocked(documentClient.send);
function request(durationMs: number) {
  return {
    headers: { "content-type": "application/json" },
    requestContext: { requestId: "request", authorizer: { jwt: { claims: { sub: "user-123" } } } },
    body: JSON.stringify({ sessionId, baseSequence: 0, events: [{
      id: "50ca3ceb-038a-4f1a-a90c-401181531de8", sessionId, sequence: 1,
      occurredAt: "2026-09-24T12:00:00Z", type: "interview.completed",
      payload: { reason: "connection-lost", durationMs, finalSequence: 1, evidenceSnapshotHash: "a".repeat(64), gradingRequested: false },
    }] }),
  };
}
function mockSession(overrides: Record<string, unknown>) {
  send.mockImplementation(async (command) => {
    if (command instanceof GetCommand) return { Item: { sessionId, userId: "user-123", status: "created", lastSequence: 0, eventCount: 0, sessionEndsAt: "2026-09-24T12:30:00Z", ...overrides } };
    if (command instanceof QueryCommand) return { Items: [] };
    if (command instanceof TransactWriteCommand) return {};
    throw new Error("Unexpected command");
  });
}
beforeEach(() => { jest.clearAllMocks(); jest.useFakeTimers().setSystemTime(new Date("2026-09-24T12:20:00Z")); });
afterEach(() => jest.useRealTimers());
it.each([
  { channel: "voice", durationMinutes: 10, durationMs: 600_001 },
  { channel: "text", durationMinutes: 5, durationMs: 300_001 },
  { durationMinutes: 10, durationMs: 600_001 },
])("rejects completion beyond the reserved duration: %j", async ({ durationMs, ...state }) => {
  mockSession(state);
  const response = await handler(request(durationMs));
  expect(response.statusCode).toBe(400);
  expect(JSON.parse(response.body).error).toBe("invalid_completion_duration");
  expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
});
it("accepts a thirty-minute text completion", async () => {
  mockSession({ channel: "text", durationMinutes: 30 });
  expect((await handler(request(1_800_000))).statusCode).toBe(202);
});
it("fails closed for corrupted persisted voice duration", async () => {
  mockSession({ channel: "voice", durationMinutes: 30 });
  expect((await handler(request(600_000))).statusCode).toBe(500);
  expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
});
it("returns the same 404 for another owner's session and a missing session", async () => {
  mockSession({ userId: "another-user" });
  const other = await handler(request(60_000));
  send.mockImplementation(async () => ({}));
  const missing = await handler(request(60_000));
  expect(other.statusCode).toBe(404);
  expect(other.body).toBe(missing.body);
});
