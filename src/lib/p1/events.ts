import type { InterviewEvent } from "./contracts";

export interface ExistingEventReference {
  id: string;
  sequence: number;
  fingerprint: string;
}

export type EventAppendConflictKind =
  | "duplicate-id-mismatch"
  | "sequence-already-used"
  | "sequence-gap";

export interface EventAppendValidation {
  accepted: InterviewEvent[];
  duplicateIds: string[];
  conflict?: {
    kind: EventAppendConflictKind;
    eventId: string;
    sequence: number;
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/**
 * Produces a deterministic identity for persistence comparisons. It may contain
 * interview content and must never be emitted to logs or metrics.
 */
export function fingerprintInterviewEvent(event: InterviewEvent): string {
  return stableJson(event);
}

/**
 * Separates safe retries from append conflicts before a conditional DynamoDB
 * transaction. The persistence layer must still enforce the same constraints
 * atomically because concurrent requests can race this pure validation step.
 */
export function validateIdempotentAppend(input: {
  events: readonly InterviewEvent[];
  lastSequence: number;
  existing: readonly ExistingEventReference[];
}): EventAppendValidation {
  if (!Number.isSafeInteger(input.lastSequence) || input.lastSequence < 0) {
    throw new RangeError("lastSequence must be a non-negative safe integer");
  }

  const byId = new Map(input.existing.map((event) => [event.id, event]));
  const bySequence = new Map(input.existing.map((event) => [event.sequence, event]));
  const accepted: InterviewEvent[] = [];
  const duplicateIds: string[] = [];

  for (const event of input.events) {
    const fingerprint = fingerprintInterviewEvent(event);
    const existingById = byId.get(event.id);

    if (existingById) {
      if (
        existingById.sequence !== event.sequence ||
        existingById.fingerprint !== fingerprint
      ) {
        return {
          accepted: [],
          duplicateIds,
          conflict: {
            kind: "duplicate-id-mismatch",
            eventId: event.id,
            sequence: event.sequence,
          },
        };
      }

      duplicateIds.push(event.id);
      continue;
    }

    const existingBySequence = bySequence.get(event.sequence);
    if (existingBySequence) {
      return {
        accepted: [],
        duplicateIds,
        conflict: {
          kind: "sequence-already-used",
          eventId: event.id,
          sequence: event.sequence,
        },
      };
    }

    const expectedSequence = input.lastSequence + accepted.length + 1;
    if (event.sequence !== expectedSequence) {
      return {
        accepted: [],
        duplicateIds,
        conflict: {
          kind: "sequence-gap",
          eventId: event.id,
          sequence: event.sequence,
        },
      };
    }

    accepted.push(event);
    const reference = { id: event.id, sequence: event.sequence, fingerprint };
    byId.set(event.id, reference);
    bySequence.set(event.sequence, reference);
  }

  return { accepted: accepted.sort((left, right) => left.sequence - right.sequence), duplicateIds };
}
