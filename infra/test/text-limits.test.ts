import { readTextLimits } from "../lib/text-limits";
import { resolveP1Config } from "../lib/p1-config";
import { textLimitsFromEnvironment } from "../lambda/shared/allowances";

describe("text channel hard caps", () => {
  it("shares the documented defaults across synth and runtime", () => {
    const defaults = { sessionMinutes: 30, maxTurns: 40, maxTurnChars: 4_000 };
    expect(readTextLimits((_name, fallback) => fallback)).toEqual(defaults);
    expect(resolveP1Config({}, {}).textLimits).toEqual(defaults);
    expect(textLimitsFromEnvironment()).toEqual(defaults);
  });
  it.each([
    ["TEXT_SESSION_MINUTES", "31"], ["TEXT_MAX_TURNS", "41"], ["TEXT_MAX_TURN_CHARS", "4001"],
    ["TEXT_MAX_TURNS", "0"], ["TEXT_MAX_TURNS", "1.5"],
  ])("fails closed for %s=%s at both boundaries", (name, value) => {
    expect(() => resolveP1Config({}, { [name]: value })).toThrow();
    const previous = process.env[name];
    try {
      process.env[name] = value;
      expect(() => textLimitsFromEnvironment()).toThrow();
    } finally {
      if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    }
  });
});
