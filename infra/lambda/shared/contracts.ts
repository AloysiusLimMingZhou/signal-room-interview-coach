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

export {
  evidenceScoreSchema,
  gradingReportSchema,
  type GradingReport,
} from "../../../src/lib/p1/report";

export const gradingMessageSchema = z.object({
  sessionId: z.string().uuid(),
  userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/),
  completionEventId: z.string().uuid(),
}).strict();

export type GradingMessage = z.infer<typeof gradingMessageSchema>;
