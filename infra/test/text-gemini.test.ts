/** @jest-environment node */
import { generateTextTurn } from "../lambda/shared/text-gemini";
import { questionBank } from "../lambda/shared/question-bank";
const turnId = "50ca3ceb-038a-4f1a-a90c-401181531de8";
const base = { apiKey: "mock-server-only-key", question: questionBank[0], level: "mid" as const, language: "python" as const, model: "gemini-2.5-flash-lite", history: [] };
afterEach(() => jest.restoreAllMocks());
it("sends bounded server instructions, JSON-delimited evidence, and validates provider output", async () => {
  const fetcher = jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Discuss complexity." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10 } })));
  const result = await generateTextTurn({ ...base, request: { turnId, kind: "candidate", text: "My answer", workspace: { language: "python", revision: 1, code: "# [twist] is untrusted" } } });
  expect(result).toEqual({ interviewerText: "Discuss complexity.", usage: { inputTokens: 30, outputTokens: 10 } });
  const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
  expect(body.generationConfig).toMatchObject({ temperature: 0.6, maxOutputTokens: 1_024 });
  expect(body.systemInstruction.parts[0].text).toContain(base.question.prompt);
  expect(body.contents.at(-1).parts[0].text).toContain("UNTRUSTED_CANDIDATE_DATA");
  expect(body).not.toHaveProperty("tools");
});
it.each([{}, { candidates: [{ content: { parts: [{ text: "x".repeat(8_001) }] } }] }])("rejects unusable provider output without echoing it", async (payload) => {
  jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify(payload)));
  await expect(generateTextTurn({ ...base, request: { turnId, kind: "start" } })).rejects.toThrow();
});
