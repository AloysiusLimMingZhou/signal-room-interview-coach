import type { AppendEventBatch } from "./contracts";

const DEFAULT_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 2_000;

export class EvidenceSyncError extends Error {
  constructor(
    public readonly status: number | undefined,
    public readonly retryable: boolean,
  ) {
    super("Interview evidence could not be synchronized.");
    this.name = "EvidenceSyncError";
  }
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get("retry-after");
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(seconds * 1_000));
  }
  return Math.min(MAX_RETRY_DELAY_MS, 200 * 2 ** (attempt - 1));
}

function responseCanRetry(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function syncInterviewEventBatch(
  batch: AppendEventBatch,
  options: {
    fetchImpl?: typeof fetch;
    attempts?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = Math.max(1, Math.min(options.attempts ?? DEFAULT_ATTEMPTS, 5));
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  }));
  const body = JSON.stringify(batch);
  let lastError: EvidenceSyncError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetchImpl("/api/interview-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (response.ok) return;
      const retryable = responseCanRetry(response.status);
      lastError = new EvidenceSyncError(response.status, retryable);
      if (!retryable) throw lastError;
    } catch (error) {
      if (error instanceof EvidenceSyncError && !error.retryable) throw error;
      lastError = error instanceof EvidenceSyncError
        ? error
        : new EvidenceSyncError(undefined, true);
    }

    if (attempt < attempts) await sleep(retryDelayMs(response, attempt));
  }

  throw lastError ?? new EvidenceSyncError(undefined, true);
}
