import { z } from "zod";

export const evidenceReferenceSchema = z.object({
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

/** Mean competency score rounded to one decimal; reports always have ≥ 1 score. */
export function overallScore(report: GradingReport): number {
  const total = report.scores.reduce((sum, score) => sum + score.score, 0);
  return Math.round((total / report.scores.length) * 10) / 10;
}
