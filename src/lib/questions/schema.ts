import { z } from "zod";

export const trackSchema = z.enum(["coding", "behavioral"]);
export const levelSchema = z.enum(["new-grad", "mid", "senior"]);
export const codeLanguageSchema = z.enum(["python", "javascript", "typescript", "java", "cpp"]);
export const questionIdSchema = z.string().max(128).regex(/^(coding|behavioral)\.[a-z0-9]+(?:-[a-z0-9]+)*\.v[1-9][0-9]{0,3}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const anchorSchema = z.object({ strong: text(1_000), weak: text(1_000) }).strict();

export const questionDefinitionSchema = z.object({
  id: questionIdSchema,
  track: trackSchema,
  levels: z.array(levelSchema).min(1).max(3),
  title: text(120),
  prompt: text(8_000),
  starterCode: z.partialRecord(codeLanguageSchema, z.string().max(12_000)).optional(),
  followUps: z.array(text(1_000)).min(2).max(6),
  twist: z.object({
    kind: z.enum(["follow-up-constraint", "behavioral-probe"]),
    prompt: text(2_000),
  }).strict(),
  hints: z.array(text(1_000)).max(6),
  rubric: z.array(z.object({
    competencyId: z.string().min(1).max(80).regex(/^[a-z][a-z0-9-]*$/),
    name: text(120),
    anchors: z.object({ "new-grad": anchorSchema, mid: anchorSchema, senior: anchorSchema }).strict(),
  }).strict()).min(3).max(5),
}).strict().superRefine((question, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if (!question.id.startsWith(`${question.track}.`)) invalid("Question ID must match its track.");
  if (new Set(question.levels).size !== question.levels.length) invalid("Levels must be unique.");
  if (new Set(question.rubric.map((item) => item.competencyId)).size !== question.rubric.length) {
    invalid("Rubric competencies must be unique.");
  }
  if (question.track === "behavioral" && (question.starterCode !== undefined || question.hints.length > 0)) {
    invalid("Behavioral questions cannot contain code or coding hints.");
  }
  if (question.twist.kind !== (question.track === "coding" ? "follow-up-constraint" : "behavioral-probe")) {
    invalid("Twist kind must match the track.");
  }
});

export const publicQuestionSchema = z.object({
  id: questionIdSchema,
  title: text(120),
  prompt: text(8_000),
  language: codeLanguageSchema.optional(),
  starterCode: z.string().max(12_000).optional(),
}).strict();

export type Track = z.infer<typeof trackSchema>;
export type Level = z.infer<typeof levelSchema>;
export type CodeLanguage = z.infer<typeof codeLanguageSchema>;
export type QuestionDefinition = z.infer<typeof questionDefinitionSchema>;
export type PublicQuestion = z.infer<typeof publicQuestionSchema>;

/** Explicit projection prevents private rubric, probes and hint leakage. */
export function publicQuestion(question: QuestionDefinition, language: CodeLanguage = "python"): PublicQuestion {
  return publicQuestionSchema.parse({
    id: question.id, title: question.title, prompt: question.prompt,
    ...(question.track === "coding" ? { language, starterCode: question.starterCode?.[language] ?? "" } : {}),
  });
}
