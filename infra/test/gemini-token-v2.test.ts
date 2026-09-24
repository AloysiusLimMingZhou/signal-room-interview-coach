/** @jest-environment node */
import { provisionGeminiToken } from "../lambda/shared/gemini";
import { questionBank } from "../lambda/shared/question-bank";
import { sessionRequestV2Schema } from "../../src/lib/p1/session-v2";

const request = sessionRequestV2Schema.parse({ channel: "voice", track: "coding", level: "new-grad", providerPreference: "gemini" });
const question = questionBank.find((entry) => entry.track === "coding")!;
const now = new Date("2026-09-24T12:00:00Z");
afterEach(() => jest.restoreAllMocks());

describe("question-bound Live credentials", () => {
  it("locks the selected question and code tool into a one-use credential with a twelve-minute ceiling", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ name: "authTokens/constrained-token" }));
    const token = await provisionGeminiToken("server-only-test-value", request, now, 60, question);
    const payload = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(token.expiresAt).toBe("2026-09-24T12:12:00.000Z");
    expect(payload.uses).toBe(1);
    expect(payload.liveConnectConstraints.config.systemInstruction.parts[0].text).toContain(question.prompt);
    expect(payload.liveConnectConstraints.config.tools[0].functionDeclarations[0].name).toBe("view_code");
    expect(JSON.stringify(payload)).not.toContain("server-only-test-value");
  });
  it("rejects text requests and mismatched questions before a provider call", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider call"));
    const text = sessionRequestV2Schema.parse({ ...request, channel: "text" });
    await expect(provisionGeminiToken("server-only-test-value", text, now, 12, question)).rejects.toThrow();
    await expect(provisionGeminiToken("server-only-test-value", request, now, 12, questionBank.find((entry) => entry.track === "behavioral")!)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
