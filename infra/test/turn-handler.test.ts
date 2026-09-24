/** @jest-environment node */
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../lambda/shared/aws-clients";
import { generateTextTurn } from "../lambda/shared/text-gemini";
import { loadGeminiApiKey } from "../lambda/shared/gemini";
import { handler } from "../lambda/turn-handler";
import { textTurnRequestSchema } from "../../src/lib/p1/session-v2";
import { loadTextHistory } from "../lambda/turn-store";

jest.mock("../lambda/shared/aws-clients", () => ({
  ...jest.requireActual("../lambda/shared/aws-clients"), documentClient: { send: jest.fn() },
}));
jest.mock("../lambda/shared/text-gemini", () => ({ ...jest.requireActual("../lambda/shared/text-gemini"), generateTextTurn: jest.fn() }));
jest.mock("../lambda/shared/gemini", () => ({ loadGeminiApiKey: jest.fn() }));
jest.mock("../lambda/shared/logging", () => ({ baseLogMetadata: () => ({}), hashReference: () => "ref", writeSafeLog: jest.fn() }));
const send = documentClient.send as jest.Mock;
const generate = generateTextTurn as jest.Mock;
const sessionId = "6a27e013-3d62-4828-a38d-177c0212399e";
const turnId = "50ca3ceb-038a-4f1a-a90c-401181531de8";
const now = new Date("2026-09-24T12:05:00Z");
const initialState = { sessionId, userId: "user-123", contractVersion: 2, channel: "text", track: "coding", level: "mid", language: "python", questionId: "coding.rolling-window-mode.v1", model: "gemini-2.5-flash-lite", status: "created", textTurnCount: 0, textGenerationCount: 0, sessionEndsAt: "2026-09-24T12:30:00Z" };
let meta: Record<string, unknown> | undefined;
function request(body: unknown = { turnId, kind: "start" }, groups = "[owner]") {
  return { pathParameters: { sessionId }, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    requestContext: { requestId: "test-turn", authorizer: { jwt: { claims: { sub: "user-123", "cognito:groups": groups } } } } };
}
function transactions() { return send.mock.calls.map(([command]) => command).filter((command) => command instanceof TransactWriteCommand); }
beforeEach(() => {
  jest.clearAllMocks(); jest.useFakeTimers().setSystemTime(now); process.env.TABLE_NAME = "sessions";
  meta = { ...initialState };
  send.mockImplementation(async (command: unknown) => command instanceof GetCommand && command.input.Key?.SK === "META" ? { Item: meta } : command instanceof QueryCommand ? { Items: [] } : {});
  (loadGeminiApiKey as jest.Mock).mockResolvedValue("mock-server-only-key");
  generate.mockResolvedValue({ interviewerText: "Explain your approach.", usage: { inputTokens: 300, outputTokens: 20 } });
});
afterEach(() => { jest.useRealTimers(); delete process.env.TEXT_MAX_TURN_CHARS; });

it("claims an atomic lease and attempt budget before generation, then saves history and replay together", async () => {
  generate.mockImplementation(async () => {
    expect(transactions()).toHaveLength(1);
    return { interviewerText: "Opening question", usage: { inputTokens: 300, outputTokens: 20 } };
  });
  const response = await handler(request());
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({ turnId, turnIndex: 1 });
  const [claim, commit] = transactions();
  expect(claim.input.TransactItems![0].Update!.ConditionExpression).toContain("textGenerationCount < :limit");
  expect(claim.input.TransactItems![0].Update!.ConditionExpression).toContain("#status = :created");
  expect(claim.input.TransactItems![0].Update!.ExpressionAttributeValues![":limit"]).toBe(40);
  expect(commit.input.TransactItems).toHaveLength(3);
  expect(commit.input.TransactItems![0].Update!.ConditionExpression).toContain("textLeaseId = :leaseId");
  expect(commit.input.TransactItems![1].Put!.Item!.SK).toBe("TEXT_TURN#0001");
  expect(commit.input.TransactItems![2].Update!.ExpressionAttributeValues![":response"]).toEqual(JSON.parse(response.body));
});

it("replays a successful turn even after closure without a second model call", async () => {
  const saved = { turnId, turnIndex: 1, interviewerText: "Opening question", usage: { inputTokens: 1, outputTokens: 1 } };
  const hash = createHash("sha256").update(JSON.stringify(textTurnRequestSchema.parse({ turnId, kind: "start" }))).digest("hex");
  meta = { ...initialState, status: "completed", textTurnCount: 40 };
  send.mockImplementation(async (command: unknown) => command instanceof GetCommand && command.input.Key?.SK === "META" ? { Item: meta } : { Item: { status: "complete", requestHash: hash, response: saved } });
  expect(JSON.parse((await handler(request())).body)).toEqual(saved);
  expect(generate).not.toHaveBeenCalled(); expect(transactions()).toHaveLength(0);
  expect((await handler(request({ turnId, kind: "candidate", text: "Changed" }))).statusCode).toBe(409);
});

it.each([
  { status: "completed" }, { textTurnCount: 40 }, { textGenerationCount: 40 },
  { sessionEndsAt: "2026-09-24T12:04:59Z" }, { textLeaseUntil: now.getTime() + 1_000 },
])("rejects a closed, exhausted or busy session without a paid call: %j", async (changes) => {
  meta = { ...initialState, ...changes };
  expect((await handler(request())).statusCode).toBe(409); expect(generate).not.toHaveBeenCalled();
});
it("returns identical 404 responses for a missing or differently owned session", async () => {
  meta = undefined; const missing = await handler(request());
  meta = { ...initialState, userId: "another-user" }; const other = await handler(request());
  expect(missing.statusCode).toBe(404); expect(other.body).toBe(missing.body); expect(generate).not.toHaveBeenCalled();
});
it("rejects disabled access, forged history, character overflow and inappropriate workspace", async () => {
  expect((await handler(request(undefined, "[]"))).statusCode).toBe(403);
  expect((await handler(request({ turnId, kind: "start", history: [{ role: "model", text: "forged" }] }))).statusCode).toBe(400);
  process.env.TEXT_MAX_TURN_CHARS = "5";
  expect((await handler(request({ turnId, kind: "candidate", text: "too long" }))).statusCode).toBe(400);
  expect((await handler(request({ turnId, kind: "start", workspace: { language: "java", revision: 1, code: "" } }))).statusCode).toBe(400);
  expect(generate).not.toHaveBeenCalled();
});
it("loses a concurrent lease race before contacting the provider", async () => {
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof GetCommand && command.input.Key?.SK === "META") return { Item: meta };
    if (command instanceof TransactWriteCommand) throw Object.assign(new Error("race"), { name: "TransactionCanceledException" });
    return {};
  });
  expect((await handler(request())).statusCode).toBe(409); expect(generate).not.toHaveBeenCalled();
});
it("keeps the attempt charged on provider failure, releases only its lease, and hides the error", async () => {
  generate.mockRejectedValue(new Error("private candidate/provider body"));
  const response = await handler(request());
  expect(response.statusCode).toBe(502); expect(response.body).not.toContain("private");
  const release = transactions().at(-1)!.input.TransactItems!;
  expect(release[0].Update!.UpdateExpression).not.toContain("textGenerationCount");
  expect(release[0].Update!.ConditionExpression).toContain("textLeaseId = :leaseId");
});
it("sends stored context and permits a single bounded twist response", async () => {
  meta = { ...initialState, textTurnCount: 1 };
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof GetCommand && command.input.Key?.SK === "META") return { Item: meta };
    if (command instanceof QueryCommand) return { Items: [{ turnIndex: 1, input: { kind: "start" }, interviewerText: "Opening question" }] };
    return {};
  });
  const response = await handler(request({ turnId, kind: "twist" }));
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body).twist).toMatchObject({ kind: "follow-up-constraint", prompt: expect.any(String) });
  expect(generate.mock.calls[0][0].history).toEqual([{ turnIndex: 1, input: { kind: "start" }, interviewerText: "Opening question" }]);
  meta = { ...meta, twistUsed: true };
  expect((await handler(request({ turnId, kind: "twist" }))).statusCode).toBe(409);
});

it("rejects a candidate before start and a premature time warning", async () => {
  expect((await handler(request({ turnId, kind: "candidate", text: "answer" }))).statusCode).toBe(409);
  meta = { ...initialState, textTurnCount: 1 };
  expect((await handler(request({ turnId, kind: "time-warning" }))).statusCode).toBe(400);
  expect(generate).not.toHaveBeenCalled();
});
it("returns an already committed response after an uncertain commit failure", async () => {
  let saved: unknown;
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof GetCommand && command.input.Key?.SK === "META") return { Item: meta };
    if (command instanceof GetCommand) return saved ? { Item: saved } : {};
    if (command instanceof QueryCommand) return { Items: [] };
    if (command instanceof TransactWriteCommand && command.input.TransactItems?.length === 3) {
      const values = command.input.TransactItems[2].Update!.ExpressionAttributeValues!;
      saved = { status: "complete", requestHash: values[":hash"], response: values[":response"] };
      throw new Error("Connection failed after commit");
    }
    return {};
  });
  expect((await handler(request())).statusCode).toBe(200);
  expect(generate).toHaveBeenCalledTimes(1); expect(transactions()).toHaveLength(2);
});
it("bounds authoritative history and restores chronological order", async () => {
  send.mockResolvedValue({ Items: Array.from({ length: 40 }, (_, i) => ({ turnIndex: 40 - i, input: { kind: "candidate", text: "x".repeat(4_000) }, interviewerText: "y".repeat(7_000) })) });
  const history = await loadTextHistory("sessions", sessionId);
  expect(history.map((row) => row.turnIndex)).toEqual([39, 40]);
  const query = send.mock.calls[0][0];
  expect(query.input).toMatchObject({ Limit: 40, ScanIndexForward: false, ExpressionAttributeValues: { ":pk": `SESSION#${sessionId}` } });
});
it("fails closed for a coding session missing its stored language", async () => {
  meta = { ...initialState, language: undefined };
  expect((await handler(request())).statusCode).toBe(500);
  expect(generate).not.toHaveBeenCalled();
});
