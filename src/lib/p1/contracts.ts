import { z } from "zod";

export const PILOT_MAX_INTERVIEW_MINUTES = 10;
// Keeps DynamoDB transactional writes below 100 items when each event also
// reserves an ID-uniqueness record and a sequence key.
export const MAX_EVENT_BATCH_SIZE = 25;
export const MAX_EVENT_BATCH_BYTES = 256 * 1024;

const boundedIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/, "Invalid identifier");

const uuid = z.string().uuid();
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const occurredAt = z.string().datetime({ offset: true });

export const sessionCreationRequestSchema = z
  .object({
    track: z.enum(["system-design", "ml-design", "algorithms"]),
    difficulty: z.enum(["mid", "senior", "staff"]),
    providerPreference: z.literal("gemini"),
    durationMinutes: z.number().int().min(1).max(PILOT_MAX_INTERVIEW_MINUTES).default(10),
  })
  .strict();

export const sessionCreationResponseSchema = z
  .object({
    sessionId: uuid,
    mode: z.literal("gemini"),
    provider: z.literal("gemini"),
    model: boundedIdentifier,
    token: z.string().min(16).max(8_192),
    expiresAt: occurredAt,
    maxDurationMinutes: z.number().int().min(1).max(PILOT_MAX_INTERVIEW_MINUTES),
    persistence: z.literal("aws").optional(),
    resume: z
      .object({
        enabled: z.boolean(),
        contextCompressionTriggerTokens: z.number().int().min(1).max(1_000_000),
        slidingWindowTokens: z.number().int().min(1).max(1_000_000),
      })
      .strict(),
  })
  .strict();

const questionPayloadSchema = z
  .object({
    questionId: uuid,
    turn: z.number().int().min(1).max(1_000),
    prompt: z.string().trim().min(1).max(8_000),
  })
  .strict();

const transcriptPayloadSchema = z
  .object({
    speaker: z.enum(["candidate", "interviewer"]),
    text: z.string().trim().min(1).max(16_000),
    evidenceId: boundedIdentifier,
    startMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1_000),
    endMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1_000),
  })
  .strict()
  .refine((value) => value.endMs >= value.startMs, {
    message: "endMs must not precede startMs",
    path: ["endMs"],
  });

const codePatchPayloadSchema = z
  .object({
    language: z.enum(["javascript", "typescript", "python"]),
    patch: z.string().min(1).max(65_536),
    baseRevision: sequence,
    revision: sequence,
  })
  .strict()
  .refine((value) => value.revision > value.baseRevision, {
    message: "revision must advance",
    path: ["revision"],
  });

const canvasFieldsSchema = z
  .object({
    label: z.string().trim().min(1).max(256).optional(),
    kind: z.enum(["client", "service", "data", "queue", "model", "edge"]).optional(),
    sourceId: boundedIdentifier.optional(),
    targetId: boundedIdentifier.optional(),
    x: z.number().finite().min(-100_000).max(100_000).optional(),
    y: z.number().finite().min(-100_000).max(100_000).optional(),
  })
  .strict();

const canvasOperationSchema = z
  .object({
    operation: z.enum(["add", "update", "remove"]),
    entity: z.enum(["node", "edge"]),
    entityId: boundedIdentifier,
    fields: canvasFieldsSchema.optional(),
  })
  .strict();

const canvasPatchPayloadSchema = z
  .object({
    baseRevision: sequence,
    revision: sequence,
    operations: z.array(canvasOperationSchema).min(1).max(100),
  })
  .strict()
  .refine((value) => value.revision > value.baseRevision, {
    message: "revision must advance",
    path: ["revision"],
  });

const codeSnapshotPayloadSchema = z
  .object({
    language: z.enum(["javascript", "typescript", "python"]),
    content: z.string().max(98_304),
    revision: sequence,
    evidenceId: boundedIdentifier,
  })
  .strict();

const canvasNodeSchema = z
  .object({
    id: boundedIdentifier,
    label: z.string().trim().min(1).max(256),
    kind: z.enum(["client", "service", "data", "queue", "model"]),
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000),
  })
  .strict();

const canvasEdgeSchema = z
  .object({
    id: boundedIdentifier,
    sourceId: boundedIdentifier,
    targetId: boundedIdentifier,
    label: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

const canvasSnapshotPayloadSchema = z
  .object({
    revision: sequence,
    nodes: z.array(canvasNodeSchema).max(200),
    edges: z.array(canvasEdgeSchema).max(400),
    evidenceId: boundedIdentifier,
  })
  .strict();

const scenarioInjectedPayloadSchema = z
  .object({
    scenarioId: boundedIdentifier,
    kind: z.enum(["traffic-spike", "component-failure", "privacy-constraint", "model-drift"]),
    title: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(4_000),
    injectedAtTurn: z.number().int().min(1).max(1_000),
  })
  .strict();

const interviewCompletedPayloadSchema = z
  .object({
    reason: z.enum(["user-ended", "time-limit", "interviewer-ended"]),
    durationMs: z.number().int().nonnegative().max(PILOT_MAX_INTERVIEW_MINUTES * 60 * 1_000),
    finalSequence: sequence,
    evidenceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    gradingRequested: z.boolean(),
  })
  .strict();

const executionResultPayloadSchema = z
  .object({
    language: z.enum(["javascript", "typescript", "python"]),
    exitCode: z.number().int().min(-1).max(255),
    stdout: z.string().max(16_384),
    stderr: z.string().max(16_384),
    durationMs: z.number().int().nonnegative().max(2_500),
    timedOut: z.boolean(),
  })
  .strict();

const reconnectPayloadSchema = z
  .object({
    attempt: z.number().int().min(1).max(20),
    reason: z.enum(["planned-reset", "network-loss", "credential-expired", "provider-error"]),
    resumed: z.boolean(),
  })
  .strict();

const toolCallPayloadSchema = z
  .object({
    toolCallId: boundedIdentifier,
    toolName: boundedIdentifier,
    status: z.enum(["requested", "succeeded", "failed"]),
    durationMs: z.number().int().nonnegative().max(60_000).optional(),
  })
  .strict();

const usagePayloadSchema = z
  .object({
    provider: z.literal("gemini"),
    model: boundedIdentifier,
    inputTokens: z.number().int().nonnegative().max(100_000_000),
    outputTokens: z.number().int().nonnegative().max(100_000_000),
    cachedTokens: z.number().int().nonnegative().max(100_000_000).optional(),
    estimatedCostUsd: z.number().finite().nonnegative().max(1_000),
  })
  .strict();

const eventBase = {
  id: uuid,
  sessionId: uuid,
  sequence: sequence.min(1),
  occurredAt,
  providerUsage: usagePayloadSchema.optional(),
};

export const interviewEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("question.started"), payload: questionPayloadSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("question.completed"), payload: questionPayloadSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("transcript.final"), payload: transcriptPayloadSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("code.patch"), payload: codePatchPayloadSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("code.snapshot"), payload: codeSnapshotPayloadSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("canvas.patch"), payload: canvasPatchPayloadSchema }).strict(),
  z
    .object({ ...eventBase, type: z.literal("canvas.snapshot"), payload: canvasSnapshotPayloadSchema })
    .strict(),
  z
    .object({ ...eventBase, type: z.literal("scenario.injected"), payload: scenarioInjectedPayloadSchema })
    .strict(),
  z
    .object({ ...eventBase, type: z.literal("execution.result"), payload: executionResultPayloadSchema })
    .strict(),
  z
    .object({ ...eventBase, type: z.literal("connection.reconnected"), payload: reconnectPayloadSchema })
    .strict(),
  z.object({ ...eventBase, type: z.literal("tool.call"), payload: toolCallPayloadSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("provider.usage"), payload: usagePayloadSchema }).strict(),
  z
    .object({ ...eventBase, type: z.literal("interview.completed"), payload: interviewCompletedPayloadSchema })
    .strict(),
]);

function utf8ByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  let bytes = 0;

  for (const character of serialized) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }

  return bytes;
}

export const appendEventBatchSchema = z
  .object({
    sessionId: uuid,
    baseSequence: sequence,
    events: z.array(interviewEventSchema).min(1).max(MAX_EVENT_BATCH_SIZE),
  })
  .strict()
  .superRefine((batch, context) => {
    const eventIds = new Set<string>();
    let completionIndex = -1;

    batch.events.forEach((event, index) => {
      if (event.sessionId !== batch.sessionId) {
        context.addIssue({
          code: "custom",
          message: "Event sessionId must match the batch sessionId",
          path: ["events", index, "sessionId"],
        });
      }

      if (eventIds.has(event.id)) {
        context.addIssue({
          code: "custom",
          message: "Event IDs must be unique within a batch",
          path: ["events", index, "id"],
        });
      }
      eventIds.add(event.id);

      const expectedSequence = batch.baseSequence + index + 1;
      if (event.sequence !== expectedSequence) {
        context.addIssue({
          code: "custom",
          message: `Expected sequence ${expectedSequence}`,
          path: ["events", index, "sequence"],
        });
      }

      if (event.type === "interview.completed") {
        if (completionIndex !== -1) {
          context.addIssue({
            code: "custom",
            message: "A batch may contain only one completion event",
            path: ["events", index, "type"],
          });
        }
        completionIndex = index;
        if (event.payload.finalSequence !== event.sequence) {
          context.addIssue({
            code: "custom",
            message: "Completion finalSequence must match its event sequence",
            path: ["events", index, "payload", "finalSequence"],
          });
        }
      }
    });

    if (completionIndex !== -1 && completionIndex !== batch.events.length - 1) {
      context.addIssue({
        code: "custom",
        message: "The completion event must be the final event in its batch",
        path: ["events", completionIndex, "type"],
      });
    }

    if (utf8ByteLength(batch) > MAX_EVENT_BATCH_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Event batch exceeds the encoded size limit",
        path: ["events"],
      });
    }
  });

export type SessionCreationRequest = z.infer<typeof sessionCreationRequestSchema>;
export type SessionCreationResponse = z.infer<typeof sessionCreationResponseSchema>;
export type InterviewEvent = z.infer<typeof interviewEventSchema>;
export type AppendEventBatch = z.infer<typeof appendEventBatchSchema>;
