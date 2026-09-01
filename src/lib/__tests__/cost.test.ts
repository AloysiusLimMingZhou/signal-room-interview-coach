import { estimateGeminiLiveCost, formatUsd, GEMINI_LIVE_PRICING } from "../cost";

describe("Gemini Live cost estimator", () => {
  it("uses the published duration rates for the planning example", () => {
    const estimate = estimateGeminiLiveCost({
      candidateAudioMinutes: 30,
      interviewerAudioMinutes: 10,
    });

    expect(GEMINI_LIVE_PRICING.audioInputPerMinute).toBe(0.005);
    expect(GEMINI_LIVE_PRICING.audioOutputPerMinute).toBe(0.018);
    expect(estimate.durationCost).toBeCloseTo(0.33, 8);
    expect(estimate.estimatedTotal).toBeCloseTo(0.33, 8);
  });

  it("adds text tokens and a context multiplier", () => {
    const estimate = estimateGeminiLiveCost({
      candidateAudioMinutes: 30,
      interviewerAudioMinutes: 10,
      textInputTokens: 1_000_000,
      textOutputTokens: 1_000_000,
      contextMultiplier: 2,
    });

    expect(estimate.textCost).toBe(5.25);
    expect(estimate.estimatedTotal).toBeCloseTo(11.16, 8);
  });

  it("does not allow negative usage to reduce cost", () => {
    const estimate = estimateGeminiLiveCost({
      candidateAudioMinutes: -5,
      interviewerAudioMinutes: -2,
      contextMultiplier: 0,
    });
    expect(estimate.estimatedTotal).toBe(0);
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});
