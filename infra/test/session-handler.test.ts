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

import { documentClient } from "../lambda/shared/aws-clients";
import { loadGeminiApiKey, provisionGeminiToken } from "../lambda/shared/gemini";
import { handler } from "../lambda/session-handler";
import type { ApiGatewayV2Event } from "../lambda/shared/http";

const mockDocumentSend = documentClient.send as jest.Mock;
const mockLoadGeminiApiKey = loadGeminiApiKey as jest.Mock;
const mockProvisionGeminiToken = provisionGeminiToken as jest.Mock;

const userId = "user-1234";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
function apiEvent(): ApiGatewayV2Event {
  return {
    body: JSON.stringify({
      track: "system-design",
      difficulty: "senior",
      providerPreference: "gemini",
      durationMinutes: 10,
    }),
    headers: {
      "content-type": "application/json",
      "idempotency-key": "request-1234",
    },
    requestContext: {
      requestId: "api-request-1234",
      authorizer: { jwt: { claims: { sub: userId } } },
    },
  };
}

describe("session credential idempotency", () => {
  beforeEach(() => {
    process.env.TABLE_NAME = "sessions";
    process.env.GEMINI_SECRET_ARN = "arn:aws:secretsmanager:ap-southeast-1:111111111111:secret:test";
    mockDocumentSend.mockReset();
    mockLoadGeminiApiKey.mockReset();
    mockProvisionGeminiToken.mockReset();
  });

  it("replays the same stored ephemeral credential without provisioning another token", async () => {
    const now = new Date();
    const crypto = await import("node:crypto");
    const canonicalHash = crypto
      .createHash("sha256")
      .update(JSON.stringify({
        track: "system-design",
        difficulty: "senior",
        providerPreference: "gemini",
        durationMinutes: 10,
      }))
      .digest("hex");
    mockDocumentSend.mockReset();
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

    const response = await handler(apiEvent());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      sessionId,
      token: "authTokens/same-one-use-token",
    });
    expect(mockLoadGeminiApiKey).not.toHaveBeenCalled();
    expect(mockProvisionGeminiToken).not.toHaveBeenCalled();
  });

  it("provisions exactly one token after winning the atomic quota reservation", async () => {
    mockDocumentSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    mockLoadGeminiApiKey.mockResolvedValue("standard-key-stays-server-side");
    mockProvisionGeminiToken.mockResolvedValue({
      token: "authTokens/new-one-use-token",
      model: "gemini-3.1-flash-live-preview",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const response = await handler(apiEvent());

    expect(response.statusCode).toBe(201);
    expect(mockLoadGeminiApiKey).toHaveBeenCalledTimes(1);
    expect(mockProvisionGeminiToken).toHaveBeenCalledTimes(1);
    expect(mockDocumentSend).toHaveBeenCalledTimes(5);
  });

  it("does not mint a token while another identical request is still provisioning", async () => {
    const crypto = await import("node:crypto");
    const canonicalHash = crypto
      .createHash("sha256")
      .update(JSON.stringify({
        track: "system-design",
        difficulty: "senior",
        providerPreference: "gemini",
        durationMinutes: 10,
      }))
      .digest("hex");
    mockDocumentSend
      .mockResolvedValueOnce({
        Item: { createdAt: new Date().toISOString(), requestHash: canonicalHash, sessionId },
      })
      .mockResolvedValueOnce({});

    const response = await handler(apiEvent());

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ error: "session_request_pending" });
    expect(mockProvisionGeminiToken).not.toHaveBeenCalled();
  });
});
