import "server-only";

const MAX_UPSTREAM_RESPONSE_BYTES = 128 * 1024;

function getP1ApiOrigin(): URL | undefined {
  const configured = process.env.P1_API_URL?.trim();
  if (!configured) return undefined;

  const url = new URL(configured);
  const isLocalDevelopment =
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocalDevelopment) {
    throw new Error("P1_API_URL must use HTTPS outside local development");
  }
  if (url.search || url.hash) throw new Error("P1_API_URL must not contain a query or fragment");
  return url;
}

export function isP1ApiEnabled(): boolean {
  return Boolean(getP1ApiOrigin());
}

export async function callP1Api(input: {
  path: "/v1/realtime/sessions" | "/v1/interview-events";
  accessToken: string;
  body: unknown;
  requestId: string;
  idempotencyKey?: string;
}): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const base = getP1ApiOrigin();
  if (!base) throw new Error("P1 API is not configured");

  const url = new URL(input.path, base.origin);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
      "X-Request-Id": input.requestId,
      ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
    },
    body: JSON.stringify(input.body),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });

  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw new Error("P1 API response was too large");
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw new Error("P1 API response was too large");
  }

  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new Error("P1 API returned invalid JSON");
    }
  }

  return { ok: response.ok, status: response.status, payload };
}
