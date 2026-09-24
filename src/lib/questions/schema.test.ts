/** @jest-environment node */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { questionDefinitionSchema, publicQuestion } from "./schema";
import { questionBank } from "../../../infra/lambda/shared/question-bank";

describe("versioned question bank", () => {
  it("validates every question and includes five new-grad questions per track", () => {
    expect(new Set(questionBank.map((question) => question.id)).size).toBe(questionBank.length);
    for (const track of ["coding", "behavioral"]) {
      const directory = join(process.cwd(), "content", "questions", track);
      const files = readdirSync(directory).filter((file) => file.endsWith(".json"));
      const eligible = questionBank.filter((question) => question.track === track && question.levels.includes("new-grad"));
      expect(eligible.length).toBeGreaterThanOrEqual(5);
      expect(files).toHaveLength(eligible.length);
      for (const file of files) {
        const definition = questionDefinitionSchema.parse(JSON.parse(readFileSync(join(directory, file), "utf8")));
        expect(definition.id).toBe(`${track}.${file.slice(0, -5)}`);
        expect(questionBank.find((question) => question.id === definition.id)).toEqual(definition);
      }
    }
    for (const question of questionBank) expect(questionDefinitionSchema.safeParse(question).success).toBe(true);
  });

  it("rejects unversioned IDs, mismatched tracks, unknown fields, and duplicate rubric competencies", () => {
    const coding = questionBank.find((question) => question.track === "coding")!;
    for (const invalid of [
      { ...coding, id: "coding.example" },
      { ...coding, id: "behavioral.example.v1" },
      { ...coding, unexpected: true },
      { ...coding, rubric: [coding.rubric[0], coding.rubric[0], coding.rubric[1]] },
      { ...coding, levels: [] },
    ]) expect(questionDefinitionSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects coding artifacts in behavioral definitions", () => {
    const question = questionBank.find((entry) => entry.track === "behavioral")!;
    expect(questionDefinitionSchema.safeParse({ ...question, starterCode: { python: "pass" } }).success).toBe(false);
    expect(questionDefinitionSchema.safeParse({ ...question, hints: ["hint"] }).success).toBe(false);
  });

  it("projects only public fields and picks the requested language starter", () => {
    for (const question of questionBank) {
      for (const language of ["python", "javascript", "typescript", "java", "cpp"] as const) {
        const projected = publicQuestion(question, question.track === "coding" ? language : undefined);
        expect(Object.keys(projected).sort()).toEqual(question.track === "coding"
          ? ["id", "language", "prompt", "starterCode", "title"] : ["id", "prompt", "title"]);
        if (question.track === "coding") expect(projected.starterCode).toBe(question.starterCode?.[language]);
        expect(projected).not.toHaveProperty("rubric");
        expect(projected).not.toHaveProperty("hints");
        expect(projected).not.toHaveProperty("twist");
      }
    }
  });
});
