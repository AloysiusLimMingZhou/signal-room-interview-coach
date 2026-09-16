import "server-only";

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;

/** Only https: and mailto: links are rendered, which blocks javascript:/data: URL injection. */
export function resolveContactUrl(raw = process.env.CONTACT_URL): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "mailto:" && EMAIL_PATTERN.test(decodeURIComponent(url.pathname))) return url.toString();
  return undefined;
}
