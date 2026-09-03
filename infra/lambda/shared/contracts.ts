import { z } from "zod";
import {
  appendEventBatchSchema,
  interviewEventSchema,
  sessionCreationRequestSchema,
  sessionCreationResponseSchema,
  type AppendEventBatch,
  type InterviewEvent,
  type SessionCreationRequest,
  type SessionCreationResponse,
} from "../../../src/lib/p1/contracts";

export {
  appendEventBatchSchema,
  interviewEventSchema,
  sessionCreationRequestSchema,
  sessionCreationResponseSchema,
};
export type { AppendEventBatch, InterviewEvent, SessionCreationRequest, SessionCreationResponse };

// Compatibility aliases keep the handlers concise while the canonical schema
// remains in src/lib/p1 and is shared with the web BFF.
export const sessionRequestSchema = sessionCreationRequestSchema;
export type SessionRequest = SessionCreationRequest;

const evidenceReferenceSchema = z.object({
  eventId: z.string().uuid(),
  rationale: z.string().trim().min(1).max(1_000),
}).strict();

export const evidenceScoreSchema = z.object({
  competency: z.string().trim().min(1).max(120),
  score: z.number().min(0).max(5),
  confidence: z.number().min(0).max(1),
  evidenceReferences: z.array(evidenceReferenceSchema).min(1).max(20),
  feedback: z.string().trim().min(1).max(4_000),
  retryPrompt: z.string().trim().min(1).max(2_000),
}).strict();

export const gradingReportSchema = z.object({
  summary: z.string().trim().min(1).max(4_000),
  scores: z.array(evidenceScoreSchema).min(1).max(20),
}).strict();

export type GradingReport = z.infer<typeof gradingReportSchema>;

export const gradingMessageSchema = z.object({
  sessionId: z.string().uuid(),
  userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/),
  completionEventId: z.string().uuid(),
}).strict();

export type GradingMessage = z.infer<typeof gradingMessageSchema>;
