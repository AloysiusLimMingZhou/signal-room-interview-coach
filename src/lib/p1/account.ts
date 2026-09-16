import { z } from "zod";
import { gradingReportSchema } from "./report";

const count = z.number().int().nonnegative().max(1_000);
const isoTimestamp = z.string().datetime({ offset: true });

export const accessRoleSchema = z.enum(["owner", "guest", "none"]);
export const quotaChannelSchema = z.enum(["voice", "text"]);

export const allowanceSchema = z.object({
  used: count,
  limit: count,
  globalRemaining: count,
  resetsAt: isoTimestamp,
}).strict();

export const meResponseSchema = z.object({
  role: accessRoleSchema,
  quotas: z.object({ voice: allowanceSchema, text: allowanceSchema }).strict(),
}).strict();

export const historyStatusSchema = z.enum(["active", "grading", "graded", "failed"]);

export const sessionSummarySchema = z.object({
  sessionId: z.string().uuid(),
  createdAt: isoTimestamp,
  channel: quotaChannelSchema,
  track: z.string().min(1).max(40),
  level: z.string().min(1).max(40),
  questionTitle: z.string().min(1).max(120),
  status: historyStatusSchema,
  overallScore: z.number().min(0).max(5).optional(),
}).strict();

export const SESSION_LIST_MAX_LIMIT = 50;

export const sessionListResponseSchema = z.object({
  items: z.array(sessionSummarySchema).max(SESSION_LIST_MAX_LIMIT),
  nextCursor: z.string().min(1).max(1_024).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();

export const reportStatusSchema = z.enum(["pending", "grading", "complete", "failed"]);
export const reportV1Schema = gradingReportSchema.extend({ schemaVersion: z.literal(1) }).strict();

export const reportResponseSchema = z.object({
  status: reportStatusSchema,
  report: reportV1Schema.optional(),
  gradedAt: isoTimestamp.optional(),
}).strict();

export type MeResponse = z.infer<typeof meResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type ReportResponse = z.infer<typeof reportResponseSchema>;
