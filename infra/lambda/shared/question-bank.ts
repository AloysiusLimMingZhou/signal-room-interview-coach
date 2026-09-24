import question0 from "../../../content/questions/coding/rolling-window-mode.v1.json";
import question1 from "../../../content/questions/coding/interval-conflicts.v1.json";
import question2 from "../../../content/questions/coding/dependency-order.v1.json";
import question3 from "../../../content/questions/coding/first-unique-event.v1.json";
import question4 from "../../../content/questions/coding/bounded-cache.v1.json";
import question5 from "../../../content/questions/behavioral/technical-disagreement.v1.json";
import question6 from "../../../content/questions/behavioral/own-a-mistake.v1.json";
import question7 from "../../../content/questions/behavioral/work-through-ambiguity.v1.json";
import question8 from "../../../content/questions/behavioral/act-on-feedback.v1.json";
import question9 from "../../../content/questions/behavioral/prioritize-under-pressure.v1.json";
import { questionDefinitionSchema, type QuestionDefinition } from "../../../src/lib/questions/schema";

// Keep the full bank under the Lambda boundary; clients receive an explicit projection.
export const questionBank: readonly QuestionDefinition[] = [
  question0,
  question1,
  question2,
  question3,
  question4,
  question5,
  question6,
  question7,
  question8,
  question9,
].map((question) => questionDefinitionSchema.parse(question));

if (new Set(questionBank.map((question) => question.id)).size !== questionBank.length) {
  throw new Error("Question IDs must be unique.");
}

export function getQuestion(id: string): QuestionDefinition {
  const question = questionBank.find((entry) => entry.id === id);
  if (!question) throw new Error("Stored question version is unavailable.");
  return question;
}
