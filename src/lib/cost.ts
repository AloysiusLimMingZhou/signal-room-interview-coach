export const GEMINI_LIVE_PRICING = {
  verifiedOn: "2026-09-01",
  audioInputPerMinute: 0.005,
  audioOutputPerMinute: 0.018,
  textInputPerMillionTokens: 0.75,
  textOutputPerMillionTokens: 4.5,
} as const;

export interface CostEstimateInput {
  candidateAudioMinutes: number;
  interviewerAudioMinutes: number;
  textInputTokens?: number;
  textOutputTokens?: number;
  contextMultiplier?: number;
}

export interface CostEstimate {
  durationCost: number;
  textCost: number;
  estimatedTotal: number;
}

const nonNegative = (value: number) => Math.max(0, value);

export function estimateGeminiLiveCost(input: CostEstimateInput): CostEstimate {
  const durationCost =
    nonNegative(input.candidateAudioMinutes) * GEMINI_LIVE_PRICING.audioInputPerMinute +
    nonNegative(input.interviewerAudioMinutes) * GEMINI_LIVE_PRICING.audioOutputPerMinute;
  const textCost =
    (nonNegative(input.textInputTokens ?? 0) / 1_000_000) *
      GEMINI_LIVE_PRICING.textInputPerMillionTokens +
    (nonNegative(input.textOutputTokens ?? 0) / 1_000_000) *
      GEMINI_LIVE_PRICING.textOutputPerMillionTokens;
  const estimatedTotal = (durationCost + textCost) * Math.max(1, input.contextMultiplier ?? 1);

  return { durationCost, textCost, estimatedTotal };
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
