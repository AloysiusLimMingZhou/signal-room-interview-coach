import { z } from "zod";

export const metricNameSchema = z.enum([
  "session_setup_ms",
  "interview_completed",
  "interview_abandoned",
  "gemini_reconnect_count",
  "gemini_error_count",
  "gemini_usage_cost_usd",
  "grading_latency_ms",
  "grading_schema_failure",
  "evidence_reference_invalid",
  "idempotency_conflict",
]);

export const metricDimensionsSchema = z
  .object({
    environment: z.enum(["development", "staging", "production"]),
    provider: z.enum(["gemini", "aws", "application"]).optional(),
    model: z
      .enum(["gemini-3.1-flash-live-preview", "gemini-flash-grader", "other"])
      .optional(),
  })
  .strict();

export const applicationMetricSchema = z
  .object({
    name: metricNameSchema,
    value: z.number().finite().nonnegative(),
    unit: z.enum(["Count", "Milliseconds", "None"]),
    dimensions: metricDimensionsSchema,
  })
  .strict()
  .superRefine((metric, context) => {
    const expectedUnit = metric.name.endsWith("_ms")
      ? "Milliseconds"
      : metric.name === "gemini_usage_cost_usd"
        ? "None"
        : "Count";

    if (metric.unit !== expectedUnit) {
      context.addIssue({
        code: "custom",
        message: `${metric.name} must use ${expectedUnit}`,
        path: ["unit"],
      });
    }
  });

export type MetricName = z.infer<typeof metricNameSchema>;
export type MetricDimensions = z.infer<typeof metricDimensionsSchema>;
export type ApplicationMetric = z.infer<typeof applicationMetricSchema>;

export function normalizeGeminiModelDimension(model: string): NonNullable<MetricDimensions["model"]> {
  return model === "gemini-3.1-flash-live-preview" ? model : "other";
}
