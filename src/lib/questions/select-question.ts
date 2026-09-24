import type { Level, QuestionDefinition, Track } from "./schema";

/** recentIds are ordered newest first, from the caller's own history partition. */
export function selectQuestion(input: {
  bank: readonly QuestionDefinition[];
  track: Track;
  level: Level;
  recentIds: readonly string[];
  rng?: () => number;
}): QuestionDefinition {
  const eligible = input.bank.filter((question) => question.track === input.track && question.levels.includes(input.level));
  if (eligible.length === 0) throw new Error("No eligible question is configured.");
  const recent = input.recentIds.slice(0, 20);
  const unseen = eligible.filter((question) => !recent.includes(question.id));
  if (unseen.length === 0) {
    return eligible.reduce((oldest, question) =>
      recent.indexOf(question.id) > recent.indexOf(oldest.id) ? question : oldest);
  }
  const random = (input.rng ?? Math.random)();
  if (!Number.isFinite(random) || random < 0 || random >= 1) throw new Error("Random source must return a value in [0, 1).");
  return unseen[Math.floor(random * unseen.length)];
}
