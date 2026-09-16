/** @jest-environment node */

jest.mock("../lambda/shared/aws-clients", () => {
  const actual = jest.requireActual("../lambda/shared/aws-clients");
  return { ...actual, documentClient: { send: jest.fn() } };
});

jest.mock("../lambda/shared/gemini", () => ({
  loadGeminiApiKey: jest.fn(),
  provisionGeminiToken: jest.fn(),
  resolvedGeminiLiveModel: () => "gemini-3.1-flash-live-preview",
}));

import { createHash } from "node:crypto";
import { documentClient } from "../lambda/shared/aws-clients";
import { loadGeminiApiKey, provisionGeminiToken } from "../lambda/shared/gemini";
import { handler } from "../lambda/session-handler";
import type { ApiGatewayV2Event } from "../lambda/shared/http";

const mockDocumentSend = documentClient.send as jest.Mock;
const mockLoadGeminiApiKey = loadGeminiApiKey as jest.Mock;
const mockProvisionGeminiToken = provisionGeminiToken as jest.Mock;

const userId = "user-1234";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const requestBody = {
  track: "system-design",
  difficulty: "senior",
  providerPreference: "gemini",
  durationMinutes: 10,
};
const canonicalHash = createHash("sha256").update(JSON.stringify(requestBody)).digest("hex");

function apiEvent(groups: string | undefined): ApiGatewayV2Event {
  return {
    body: JSON.stringify(requestBody),
    headers: { "content-type": "application/json", "idempotency-key": "request-1234" },
    requestContext: {
      requestId: "api-request-1234",
      authorizer: { jwt: { claims: { sub: userId, ...(groups ? { "cognito:groups": groups } : {}) } } },
    },
  };
}

function provisionSucceeds() {
  mockLoadGeminiApiKey.mockResolvedValue("standard-key-stays-server-side");
  mockProvisionGeminiToken.mockResolvedValue({
    token: "authTokens/new-one-use-token",
    model: "gemini-3.1-flash-live-preview",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

describe("session creation", () => {
  beforeEach(() => {
    process.env.TABLE_NAME = "sessions";
    process.env.GEMINI_KEY_PARAMETER_NAME = "/signal-room/test/gemini-api-key";
    mockDocumentSend.mockReset();
    mockLoadGeminiApiKey.mockReset();
    mockProvisionGeminiToken.mockReset();
  });

  it("replays the same stored ephemeral credential without provisioning another token", async () => {
    const now = new Date();
    mockDocumentSend
      .mockResolvedValueOnce({ Item: { createdAt: now.toISOString(), requestHash: canonicalHash, sessionId } })
      .mockResolvedValueOnce({
        Item: {
          requestHash: canonicalHash,
          sessionId,
          token: "authTokens/same-one-use-token",
          model: "gemini-3.1-flash-live-preview",
          tokenExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
          durationMinutes: 10,
        },
      });

    const response = await handler(apiEvent("[owner]"));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ sessionId, token: "authTokens/same-one-use-token" });
    expect(mockProvisionGeminiToken).not.toHaveBeenCalled();
  });

  it("does not mint a token while another identical request is still provisioning", async () => {
    mockDocumentSend
      .mockResolvedValueOnce({ Item: { createdAt: new Date().toISOString(), requestHash: canonicalHash, sessionId } })
      .mockResolvedValueOnce({});

    const response = await handler(apiEvent("[owner]"));

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ error: "session_request_pending" });
    expect(mockProvisionGeminiToken).not.toHaveBeenCalled();
  });

  it("rejects an account outside the owner and guest groups before touching quota", async () => {
    const response = await handler(apiEvent(undefined));

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: "account_not_enabled" });
    expect(mockDocumentSend).not.toHaveBeenCalled();
  });

  it("reserves voice quota and writes the history item in the session transaction", async () => {
    mockDocumentSend.mockResolvedValue({});
    provisionSucceeds();

    const response = await handler(apiEvent("[owner]"));

    expect(response.statusCode).toBe(201);
    expect(mockProvisionGeminiToken).toHaveBeenCalledTimes(1);
    expect(mockDocumentSend).toHaveBeenCalledTimes(5);
    const items = mockDocumentSend.mock.calls[3][0].input.TransactItems;
    expect(items[0].Update.Key.PK).toBe("QUOTA#GLOBAL#VOICE");
    expect(items[1].Update.Key.PK).toBe(`QUOTA#USER#${userId}#VOICE`);
    expect(items[1].Update.ExpressionAttributeValues[":limit"]).toBe(10);
    const meta = items[3].Put.Item;
    const history = items[4].Put.Item;
    expect(meta).toMatchObject({ role: "owner", channel: "voice" });
    expect(history).toMatchObject({
      PK: `USER#${userId}`,
      SK: meta.historySk,
      entityType: "SessionHistory",
      channel: "voice",
      track: "system-design",
      level: "senior",
      questionTitle: "System design",
      status: "active",
    });
    expect(history.SK).toMatch(/^SESSION#\d{4}-\d{2}-\d{2}T.*#[0-9a-f-]{36}$/);
  });

  it("applies the guest voice allowance", async () => {
    mockDocumentSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { used: 0 } })
      .mockResolvedValueOnce({ Item: { used: 2 } });

    const response = await handler(apiEvent("[guest]"));

    expect(response.statusCode).toBe(429);
    expect(mockProvisionGeminiToken).not.toHaveBeenCalled();
  });

  it("releases the reservation and history item when provisioning fails", async () => {
    mockDocumentSend.mockResolvedValue({});
    mockLoadGeminiApiKey.mockResolvedValue("standard-key-stays-server-side");
    mockProvisionGeminiToken.mockRejectedValue(new Error("Gemini ephemeral-token provisioning failed."));

    const response = await handler(apiEvent("[owner]"));

    expect(response.statusCode).toBe(503);
    const rollback = mockDocumentSend.mock.calls[4][0].input.TransactItems;
    expect(rollback).toHaveLength(5);
    expect(rollback[4].Delete.Key.PK).toBe(`USER#${userId}`);
    expect(rollback[4].Delete.Key.SK).toMatch(/^SESSION#/);
  });
});
