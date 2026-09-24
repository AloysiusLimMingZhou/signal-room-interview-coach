import { z } from "zod";
import { codeLanguageSchema, levelSchema, publicQuestionSchema } from "../questions/schema";

export const TEXT_MAX_SESSION_MINUTES = 30;
export const TEXT_MAX_TURNS = 40;
export const TEXT_MAX_TURN_CHARS = 4_000;
export const MAX_WORKSPACE_CHARS = 12_000;

const requestFields = {
  channel: z.enum(["voice", "text"]),
  level: levelSchema,
  providerPreference: z.literal("gemini"),
  durationMinutes: z.number().int().min(1).max(TEXT_MAX_SESSION_MINUTES).optional(),
};
export const sessionRequestV2Schema = z.discriminatedUnion("track", [
  z.object({ ...requestFields, track: z.literal("coding"), language: codeLanguageSchema.default("python") }).strict(),
  z.object({ ...requestFields, track: z.literal("behavioral") }).strict(),
]).superRefine((request, ctx) => {
  if (request.channel === "voice" && (request.durationMinutes ?? 10) > 10) {
    ctx.addIssue({ code: "custom", message: "Voice sessions cannot exceed ten minutes.", path: ["durationMinutes"] });
  }
}).transform((request) => ({ ...request, durationMinutes: request.durationMinutes ?? (request.channel === "voice" ? 10 : 30) }));

const descriptor = {
  sessionId: z.string().uuid(),
  provider: z.literal("gemini"),
  model: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  expiresAt: z.string().datetime({ offset: true }),
  persistence: z.literal("aws"),
  question: publicQuestionSchema,
};
export const sessionResponseV2Schema = z.discriminatedUnion("channel", [
  z.object({
    ...descriptor, channel: z.literal("voice"), mode: z.literal("gemini"),
    token: z.string().min(16).max(8_192),
    maxDurationMinutes: z.number().int().min(1).max(10),
    resume: z.object({
      enabled: z.boolean(), contextCompressionTriggerTokens: z.number().int().min(1).max(1_000_000),
      slidingWindowTokens: z.number().int().min(1).max(1_000_000),
    }).strict(),
  }).strict(),
  z.object({
    ...descriptor, channel: z.literal("text"), maxDurationMinutes: z.number().int().min(1).max(30),
    maxTurns: z.number().int().min(1).max(TEXT_MAX_TURNS),
  }).strict(),
]);

export const workspaceSchema = z.object({
  language: codeLanguageSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  code: z.string().max(MAX_WORKSPACE_CHARS),
}).strict();
const turnFields = { turnId: z.string().uuid(), workspace: workspaceSchema.optional() };
export const textTurnRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...turnFields, kind: z.literal("candidate"), text: z.string().trim().min(1).max(TEXT_MAX_TURN_CHARS) }).strict(),
  z.object({ ...turnFields, kind: z.enum(["start", "twist", "time-warning"]) }).strict(),
]);
export const textTurnResponseSchema = z.object({
  turnId: z.string().uuid(), turnIndex: z.number().int().min(1).max(TEXT_MAX_TURNS),
  interviewerText: z.string().trim().min(1).max(8_000),
  twist: z.object({ kind: z.enum(["follow-up-constraint", "behavioral-probe"]), prompt: z.string().min(1).max(4_000) }).strict().optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().max(1_000_000),
    outputTokens: z.number().int().nonnegative().max(1_000_000),
  }).strict(),
}).strict();

export type SessionRequestV2 = z.infer<typeof sessionRequestV2Schema>;
export type SessionResponseV2 = z.infer<typeof sessionResponseV2Schema>;
export type TextTurnRequest = z.infer<typeof textTurnRequestSchema>;
export type TextTurnResponse = z.infer<typeof textTurnResponseSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
