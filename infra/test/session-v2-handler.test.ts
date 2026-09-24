/** @jest-environment node */
jest.mock("../lambda/shared/aws-clients", () => ({
  ...jest.requireActual("../lambda/shared/aws-clients"), documentClient: { send: jest.fn() },
}));
jest.mock("../lambda/shared/gemini", () => ({
  loadGeminiApiKey: jest.fn(), provisionGeminiToken: jest.fn(),
  resolvedGeminiLiveModel: () => "gemini-3.1-flash-live-preview",
}));

import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../lambda/shared/aws-clients";
import { loadGeminiApiKey, provisionGeminiToken } from "../lambda/shared/gemini";
import { handler } from "../lambda/session-handler";
import { questionBank } from "../lambda/shared/question-bank";
import type { ApiGatewayV2Event } from "../lambda/shared/http";

const send = documentClient.send as jest.Mock;
const provision = provisionGeminiToken as jest.Mock;
const loadKey = loadGeminiApiKey as jest.Mock;
const userId = "user-1234";
const request = { channel: "text", track: "coding", level: "new-grad", providerPreference: "gemini", durationMinutes: 30 };
function event(body: unknown = request, groups = "[owner]"): ApiGatewayV2Event {
  return { body: JSON.stringify(body), headers: { "content-type": "application/json", "idempotency-key": "v2-request-1234" },
    requestContext: { requestId: "v2-request", authorizer: { jwt: { claims: { sub: userId, "cognito:groups": groups } } } } };
}
function transactions() {
  return send.mock.calls.map(([command]) => command).filter((command) => command instanceof TransactWriteCommand);
}

beforeEach(() => {
  process.env.TABLE_NAME = "sessions";
  send.mockReset().mockImplementation(async (command: unknown) => command instanceof QueryCommand ? { Items: [] } : {});
  loadKey.mockReset().mockResolvedValue("standard-key-stays-server-side");
  provision.mockReset().mockResolvedValue({ token: "authTokens/v2-one-use-token", model: "gemini-3.1-flash-live-preview", expiresAt: new Date(Date.now() + 600_000).toISOString() });
});

describe("Phase 2 session creation", () => {
  it("atomically reserves text quota, history and replay response without contacting Gemini", async () => {
    const result = await handler(event());
    expect(result.statusCode).toBe(201);
    const response = JSON.parse(result.body);
    expect(response).toMatchObject({ channel: "text", maxTurns: 40, maxDurationMinutes: 30, question: { language: "python" } });
    expect(response).not.toHaveProperty("token");
    expect(response.question).not.toHaveProperty("rubric");
    expect(loadKey).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    const tx = transactions();
    expect(tx).toHaveLength(1);
    const items = tx[0].input.TransactItems!;
    expect(items[0].Update).toMatchObject({ Key: { PK: "QUOTA#GLOBAL#TEXT" }, ConditionExpression: "attribute_not_exists(#used) OR #used < :limit", ExpressionAttributeValues: { ":limit": 60 } });
    expect(items[1].Update).toMatchObject({ Key: { PK: `QUOTA#USER#${userId}#TEXT` }, ExpressionAttributeValues: { ":limit": 60 } });
    expect(items[3].Put!.Item).toMatchObject({ userId, channel: "text", status: "created", questionId: response.question.id, level: "new-grad", textTurnCount: 0 });
    expect(items[4].Put!.Item).toMatchObject({ PK: `USER#${userId}`, questionId: response.question.id, questionTitle: response.question.title });
    expect(items[5].Put!.Item!.response).toEqual(response);
  });

  it("uses only the caller's latest history to avoid recent questions", async () => {
    const prior = questionBank.filter((question) => question.track === "coding").slice(0, 4);
    send.mockImplementation(async (command: unknown) => command instanceof QueryCommand
      ? { Items: prior.map((question) => ({ questionId: question.id })) } : {});
    const result = await handler(event());
    expect(result.statusCode).toBe(201);
    expect(prior.map((question) => question.id)).not.toContain(JSON.parse(result.body).question.id);
    const query = send.mock.calls.find(([command]) => command instanceof QueryCommand)![0];
    expect(query.input).toMatchObject({ Limit: 20, ScanIndexForward: false, ExpressionAttributeValues: { ":pk": `USER#${userId}`, ":prefix": "SESSION#" } });
  });

  it("locks the selected question into voice token provisioning and uses guest voice quota", async () => {
    const result = await handler(event({ ...request, channel: "voice", durationMinutes: 10, language: "java" }, "[guest]"));
    expect(result.statusCode).toBe(201);
    expect(provision).toHaveBeenCalledTimes(1);
    const response = JSON.parse(result.body);
    expect(provision.mock.calls[0].at(-1)).toMatchObject({ id: response.question.id });
    expect(provision.mock.calls[0][3]).toBe(12);
    expect(transactions()[0].input.TransactItems![1].Update!.ExpressionAttributeValues![":limit"]).toBe(2);
    expect(response).toMatchObject({ channel: "voice", token: "authTokens/v2-one-use-token", question: { language: "java" } });
  });

  it("replays the exact stored response without a second reservation or provider call", async () => {
    const created = await handler(event());
    expect(created.statusCode).toBe(201);
    const items = transactions()[0].input.TransactItems!;
    const original = JSON.parse(created.body);
    send.mockClear();
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof GetCommand && String(command.input.Key?.SK).startsWith("SESSION_REQUEST#")) return { Item: items[2].Put!.Item };
      if (command instanceof GetCommand && String(command.input.Key?.SK).startsWith("SESSION_RESPONSE#")) return { Item: items[5].Put!.Item };
      return {};
    });
    const replay = await handler(event());
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body)).toEqual(original);
    expect(transactions()).toHaveLength(0);
    expect(provision).not.toHaveBeenCalled();
  });

  it("rejects disabled accounts and unsupported session configuration without table calls", async () => {
    expect((await handler(event(request, "[]"))).statusCode).toBe(403);
    expect((await handler(event({ ...request, durationMinutes: 31 }))).statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("replays a transaction race instead of reserving again", async () => {
    const first = await handler(event());
    const items = transactions()[0].input.TransactItems!;
    send.mockClear();
    let requestReads = 0;
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof GetCommand && String(command.input.Key?.SK).startsWith("SESSION_REQUEST#")) {
        return requestReads++ === 0 ? {} : { Item: items[2].Put!.Item };
      }
      if (command instanceof GetCommand && String(command.input.Key?.SK).startsWith("SESSION_RESPONSE#")) return { Item: items[5].Put!.Item };
      if (command instanceof TransactWriteCommand) throw Object.assign(new Error("Race"), { name: "TransactionCanceledException" });
      return {};
    });
    const raced = await handler(event());
    expect(raced.statusCode).toBe(200);
    expect(JSON.parse(raced.body)).toEqual(JSON.parse(first.body));
    expect(transactions()).toHaveLength(1);
    expect(provision).not.toHaveBeenCalled();
  });

  it("compensates a failed voice token while retaining guarded quota decrements", async () => {
    provision.mockRejectedValue(new Error("Gemini token failed"));
    const result = await handler(event({ ...request, channel: "voice", durationMinutes: 10 }));
    expect(result.statusCode).toBe(503);
    expect(transactions()).toHaveLength(2);
    expect(transactions()[1].input.TransactItems![0].Update!.ConditionExpression).toBe("#used >= :one");
    expect(transactions()[1].input.TransactItems![3].Delete!.ConditionExpression).toBe("userId = :userId AND #status = :provisioning");
  });

  it("returns a bounded, channel-specific quota denial", async () => {
    send.mockImplementation(async (command: unknown) => command instanceof GetCommand && command.input.Key?.PK === "QUOTA#GLOBAL#TEXT" ? { Item: { used: 60 } } : {});
    const result = await handler(event());
    expect(result.statusCode).toBe(429);
    expect(JSON.parse(result.body)).toMatchObject({ error: "monthly_quota_exhausted", channel: "text", scope: "global", resetsAt: expect.any(String) });
    expect(transactions()).toHaveLength(0);
    expect(provision).not.toHaveBeenCalled();
  });
});
