/** @jest-environment node */
jest.mock("../lambda/shared/aws-clients", () => {
  const actual = jest.requireActual("../lambda/shared/aws-clients");
  return { ...actual, ssmClient: { send: jest.fn() } };
});

import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { ssmClient } from "../lambda/shared/aws-clients";
import { clearGeminiApiKeyCache, loadGeminiApiKey } from "../lambda/shared/gemini";

const mockSend = ssmClient.send as jest.Mock;
const apiKey = "k".repeat(39);

describe("Gemini API key loading", () => {
  beforeEach(() => {
    process.env.GEMINI_KEY_PARAMETER_NAME = "/signal-room/test/gemini-api-key";
    mockSend.mockReset();
    clearGeminiApiKeyCache();
  });

  it("reads the SecureString parameter with decryption", async () => {
    mockSend.mockResolvedValue({ Parameter: { Value: apiKey } });
    await expect(loadGeminiApiKey(0)).resolves.toBe(apiKey);
    const command = mockSend.mock.calls[0][0] as GetParameterCommand;
    expect(command).toBeInstanceOf(GetParameterCommand);
    expect(command.input).toEqual({ Name: "/signal-room/test/gemini-api-key", WithDecryption: true });
  });

  it("caches the key for five minutes per container", async () => {
    mockSend.mockResolvedValue({ Parameter: { Value: apiKey } });
    await loadGeminiApiKey(0);
    await loadGeminiApiKey(299_999);
    expect(mockSend).toHaveBeenCalledTimes(1);
    await loadGeminiApiKey(300_000);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("accepts the JSON value shape", async () => {
    mockSend.mockResolvedValue({ Parameter: { Value: JSON.stringify({ GEMINI_API_KEY: apiKey }) } });
    await expect(loadGeminiApiKey(0)).resolves.toBe(apiKey);
  });

  it("rejects a placeholder without caching it", async () => {
    mockSend
      .mockResolvedValueOnce({ Parameter: { Value: "short" } })
      .mockResolvedValueOnce({ Parameter: { Value: apiKey } });
    await expect(loadGeminiApiKey(0)).rejects.toThrow(/not configured/);
    await expect(loadGeminiApiKey(1)).resolves.toBe(apiKey);
  });
});
