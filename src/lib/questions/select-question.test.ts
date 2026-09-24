import { questionBank } from "../../../infra/lambda/shared/question-bank";
import { selectQuestion } from "./select-question";

const coding = questionBank.filter((question) => question.track === "coding");
describe("question selection", () => {
  it("uses an injected random source to select only eligible, unused questions", () => {
    const selected = selectQuestion({ bank: questionBank, track: "coding", level: "new-grad", recentIds: [coding[0].id], rng: () => 0 });
    expect(selected.id).toBe(coding[1].id);
    const last = selectQuestion({ bank: coding, track: "coding", level: "new-grad", recentIds: [], rng: () => 0.999 });
    expect(last.id).toBe(coding.at(-1)!.id);
  });

  it("uses the least recently used question after all eligible questions were seen", () => {
    const recentIds = [coding[0].id, coding[1].id, ...coding.slice(2).map((question) => question.id), coding[0].id];
    expect(selectQuestion({ bank: coding, track: "coding", level: "mid", recentIds }).id).toBe(coding.at(-1)!.id);
  });

  it("bounds history to twenty entries", () => {
    const recentIds = [...Array.from({ length: 20 }, () => "behavioral.other.v1"), coding[0].id];
    expect(selectQuestion({ bank: coding, track: "coding", level: "senior", recentIds, rng: () => 0 }).id).toBe(coding[0].id);
  });

  it("fails closed without eligible questions or with an invalid RNG", () => {
    const input = { bank: coding, track: "coding" as const, level: "new-grad" as const, recentIds: [] };
    expect(() => selectQuestion({ ...input, bank: [] })).toThrow(/eligible/i);
    for (const invalid of [-1, 1, NaN, Infinity]) expect(() => selectQuestion({ ...input, rng: () => invalid })).toThrow(/random/i);
  });
});
