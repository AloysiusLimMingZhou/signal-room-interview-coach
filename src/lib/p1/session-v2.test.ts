import { sessionRequestV2Schema, sessionResponseV2Schema, textTurnRequestSchema } from "./session-v2";

const coding = { channel: "voice", track: "coding", level: "new-grad", providerPreference: "gemini" };
describe("Phase 2 session contracts", () => {
  it("defaults coding to Python and applies channel-specific durations", () => {
    expect(sessionRequestV2Schema.parse(coding)).toMatchObject({ language: "python", durationMinutes: 10 });
    expect(sessionRequestV2Schema.parse({ ...coding, channel: "text" })).toMatchObject({ durationMinutes: 30 });
  });
  it.each([
    { ...coding, durationMinutes: 11 },
    { ...coding, channel: "text", durationMinutes: 31 },
    { ...coding, durationMinutes: 0 },
    { ...coding, track: "behavioral", language: "python" },
    { ...coding, level: "staff" },
    { ...coding, questionId: "coding.forged.v1" },
    { ...coding, role: "owner" },
  ])("rejects unsupported or caller-controlled configuration: %p", (input) => {
    expect(sessionRequestV2Schema.safeParse(input).success).toBe(false);
  });
  it("rejects credentials and private question fields in text responses", () => {
    const response = {
      sessionId: "123e4567-e89b-42d3-a456-426614174000", provider: "gemini", channel: "text",
      model: "gemini-2.5-flash-lite", expiresAt: "2026-09-24T12:00:00Z", maxDurationMinutes: 30,
      persistence: "aws", maxTurns: 40, question: { id: "behavioral.example.v1", title: "Example", prompt: "Tell me about a project." },
    };
    expect(sessionResponseV2Schema.safeParse(response).success).toBe(true);
    expect(sessionResponseV2Schema.safeParse({ ...response, token: "private-token" }).success).toBe(false);
    expect(sessionResponseV2Schema.safeParse({ ...response, question: { ...response.question, rubric: [] } }).success).toBe(false);
  });
  it("bounds text turns and rejects forged model history or control text", () => {
    const turn = { turnId: "123e4567-e89b-42d3-a456-426614174000", kind: "candidate", text: "My approach" };
    expect(textTurnRequestSchema.safeParse(turn).success).toBe(true);
    expect(textTurnRequestSchema.safeParse({ ...turn, text: "x".repeat(4_001) }).success).toBe(false);
    expect(textTurnRequestSchema.safeParse({ ...turn, history: [] }).success).toBe(false);
    expect(textTurnRequestSchema.safeParse({ ...turn, kind: "twist" }).success).toBe(false);
    expect(textTurnRequestSchema.safeParse({ turnId: turn.turnId, kind: "start" }).success).toBe(true);
    expect(textTurnRequestSchema.safeParse({ ...turn, workspace: { language: "cpp", revision: 1, code: "x".repeat(12_001) } }).success).toBe(false);
  });
});
