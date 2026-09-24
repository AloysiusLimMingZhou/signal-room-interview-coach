/** @jest-environment node */
jest.mock("../lambda/shared/aws-clients", () => {
  const actual = jest.requireActual("../lambda/shared/aws-clients");
  return { ...actual, documentClient: { send: jest.fn() } };
});

import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "../lambda/account-handler";
import { documentClient } from "../lambda/shared/aws-clients";
import type { ApiGatewayV2Event } from "../lambda/shared/http";

const mockSend = documentClient.send as jest.Mock;
const userId = "user-1234";
const sessionId = "6a27e013-3d62-4828-a38d-177c0212399e";
const historySk = `SESSION#2026-09-15T10:00:00.000Z#${sessionId}`;
const eventId = "0e8f2a4c-6b1d-4c3e-9f5a-1b2c3d4e5f60";

// NOTE: `groups` has no default (fixed from the brief's buggy version, which defaulted
// to "[owner]" — a JS default parameter only applies when the argument is `undefined`,
// so `event(route, {}, undefined)` silently became "[owner]" and could never exercise
// the no-group path). Every call site now passes `groups` explicitly.
function event(
  routeKey: string,
  extra: Partial<ApiGatewayV2Event> = {},
  groups: string | undefined,
): ApiGatewayV2Event {
  return {
    routeKey,
    requestContext: {
      requestId: "request-1",
      authorizer: { jwt: { claims: { sub: userId, ...(groups ? { "cognito:groups": groups } : {}) } } },
    },
    ...extra,
  };
}

function body(response: { body: string }) {
  return JSON.parse(response.body);
}

beforeEach(() => {
  process.env.TABLE_NAME = "sessions";
  mockSend.mockReset();
  jest.useFakeTimers({
    now: new Date("2026-09-15T12:00:00.000Z"),
    doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
  });
});

afterEach(() => jest.useRealTimers());

describe("GET /v1/me", () => {
  it("reports the role and per-channel allowances for the current UTC month", async () => {
    const used: Record<string, number> = { "QUOTA#GLOBAL#VOICE": 3, [`QUOTA#USER#${userId}#VOICE`]: 1 };
    mockSend.mockImplementation(async (command: GetCommand) => {
      const pk = String(command.input.Key?.PK);
      return used[pk] === undefined ? {} : { Item: { used: used[pk] } };
    });

    const response = await handler(event("GET /v1/me", {}, "[owner]"));

    expect(response.statusCode).toBe(200);
    expect(body(response)).toEqual({
      role: "owner",
      quotas: {
        voice: { used: 1, limit: 10, globalRemaining: 7, resetsAt: "2026-10-01T00:00:00.000Z" },
        text: { used: 0, limit: 60, globalRemaining: 60, resetsAt: "2026-10-01T00:00:00.000Z" },
      },
    });
    expect(mockSend.mock.calls.every(([command]) => command.input.Key.SK === "MONTH#2026-09")).toBe(true);
  });

  it("gives an ungrouped account no allowance", async () => {
    mockSend.mockResolvedValue({});
    const response = await handler(event("GET /v1/me", {}, undefined));
    expect(body(response)).toMatchObject({ role: "none", quotas: { voice: { limit: 0 }, text: { limit: 0 } } });
  });
});

describe("GET /v1/sessions", () => {
  const storedItem = {
    PK: `USER#${userId}`,
    SK: historySk,
    entityType: "SessionHistory",
    sessionId,
    createdAt: "2026-09-15T10:00:00.000Z",
    channel: "voice",
    track: "algorithms",
    level: "mid",
    questionTitle: "Algorithms",
    status: "graded",
    overallScore: 3.5,
  };

  it("lists history newest first without storage keys and round-trips the cursor", async () => {
    mockSend.mockResolvedValue({ Items: [storedItem], LastEvaluatedKey: { PK: `USER#${userId}`, SK: historySk } });

    const first = body(
      await handler(event("GET /v1/sessions", { queryStringParameters: { limit: "1" } }, "[owner]")),
    );

    expect(first.items).toEqual([{
      sessionId,
      createdAt: "2026-09-15T10:00:00.000Z",
      channel: "voice",
      track: "algorithms",
      level: "mid",
      questionTitle: "Algorithms",
      status: "graded",
      overallScore: 3.5,
    }]);
    expect((mockSend.mock.calls[0][0] as QueryCommand).input).toMatchObject({
      ScanIndexForward: false,
      Limit: 1,
      ExpressionAttributeValues: { ":pk": `USER#${userId}`, ":prefix": "SESSION#" },
    });

    const second = await handler(
      event("GET /v1/sessions", { queryStringParameters: { cursor: first.nextCursor } }, "[owner]"),
    );
    expect(second.statusCode).toBe(200);
    expect((mockSend.mock.calls[1][0] as QueryCommand).input.ExclusiveStartKey).toEqual({
      PK: `USER#${userId}`,
      SK: historySk,
    });
  });

  it("rejects a cursor that points into another user's partition", async () => {
    const forged = Buffer.from(JSON.stringify({ PK: "USER#someone-else", SK: "SESSION#x" })).toString("base64url");
    const response = await handler(
      event("GET /v1/sessions", { queryStringParameters: { cursor: forged } }, "[owner]"),
    );
    expect(response.statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    "not+base64/url=",
    "x".repeat(1_025),
    Buffer.from("not JSON").toString("base64url"),
    Buffer.from("[]").toString("base64url"),
    Buffer.from(JSON.stringify({ PK: `USER#${userId}`, SK: historySk, extra: "forged" })).toString("base64url"),
    Buffer.from(JSON.stringify({ PK: `USER#${userId}`, SK: "SESSION_REQUEST#key" })).toString("base64url"),
    Buffer.from(JSON.stringify({ PK: `USER#${userId}`, SK: `SESSION#${"x".repeat(256)}` })).toString("base64url"),
  ])("rejects malformed cursors before querying: %s", async (cursor) => {
    const response = await handler(event("GET /v1/sessions", { queryStringParameters: { cursor } }, "[owner]"));
    expect(response.statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(["0", "51", "1.5", "abc"])("rejects limit=%s", async (limit) => {
    const response = await handler(event("GET /v1/sessions", { queryStringParameters: { limit } }, "[owner]"));
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /v1/sessions/{sessionId}/report", () => {
  const reportRoute = "GET /v1/sessions/{sessionId}/report";

  function tableWith(meta: Record<string, unknown> | undefined, report: Record<string, unknown> | undefined) {
    mockSend.mockImplementation(async (command: GetCommand) =>
      command.input.Key?.SK === "META" ? { Item: meta } : { Item: report });
  }

  it("hides sessions owned by another user without reading the report", async () => {
    tableWith({ userId: "someone-else" }, undefined);
    const response = await handler(event(reportRoute, { pathParameters: { sessionId } }, "[owner]"));
    expect(response.statusCode).toBe(404);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("makes missing and foreign sessions indistinguishable without reading either report", async () => {
    tableWith(undefined, undefined);
    const missing = await handler(event(reportRoute, { pathParameters: { sessionId } }, "[owner]"));
    expect(mockSend).toHaveBeenCalledTimes(1);
    mockSend.mockClear();
    tableWith({ userId: "someone-else" }, undefined);
    const foreign = await handler(event(reportRoute, { pathParameters: { sessionId } }, "[owner]"));
    expect(foreign).toEqual(missing);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a corrupt stored report without exposing its contents", async () => {
    tableWith({ userId }, { status: "complete", report: { summary: "private corrupt content", scores: [] } });
    const response = await handler(event(reportRoute, { pathParameters: { sessionId } }, "[owner]"));
    expect(response.statusCode).toBe(500);
    expect(body(response).error).toBe("internal_error");
    expect(response.body).not.toContain("private corrupt content");
  });

  it("rejects a malformed session id without reading the table", async () => {
    const response = await handler(event(reportRoute, { pathParameters: { sessionId: "../../etc" } }, "[owner]"));
    expect(response.statusCode).toBe(404);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns pending before grading starts", async () => {
    tableWith({ userId }, undefined);
    expect(body(await handler(event(reportRoute, { pathParameters: { sessionId } }, "[owner]")))).toEqual({
      status: "pending",
    });
  });

  it("returns the completed v1 report with its schema version", async () => {
    tableWith({ userId }, {
      status: "complete",
      createdAt: "2026-09-15T10:05:00.000Z",
      report: {
        summary: "Clear approach.",
        scores: [{
          competency: "Problem solving",
          score: 4,
          confidence: 0.8,
          evidenceReferences: [{ eventId, rationale: "Chose a hash map." }],
          feedback: "State the complexity.",
          retryPrompt: "Explain the complexity.",
        }],
      },
    });
    const result = body(await handler(event(reportRoute, { pathParameters: { sessionId } }, "[owner]")));
    expect(result).toMatchObject({
      status: "complete",
      gradedAt: "2026-09-15T10:05:00.000Z",
      report: { schemaVersion: 1 },
    });
  });

  it("maps a failed report", async () => {
    tableWith({ userId }, { status: "failed" });
    expect(body(await handler(event(reportRoute, { pathParameters: { sessionId } }, "[owner]")))).toEqual({
      status: "failed",
    });
  });
});

describe("routing and authentication", () => {
  it("returns 404 for unknown routes", async () => {
    expect((await handler(event("GET /v1/unknown", {}, "[owner]"))).statusCode).toBe(404);
  });

  it("requires a signed-in caller", async () => {
    const anonymous: ApiGatewayV2Event = { routeKey: "GET /v1/me", requestContext: { requestId: "request-1" } };
    expect((await handler(anonymous)).statusCode).toBe(401);
  });
});
