/** @jest-environment node */
import { resolveContactUrl } from "./contact-url";

describe("resolveContactUrl", () => {
  it.each([
    ["https://forms.example.com/signal-room", "https://forms.example.com/signal-room"],
    ["mailto:owner@example.com", "mailto:owner@example.com"],
  ])("exposes %s", (raw, expected) => {
    expect(resolveContactUrl(raw)).toBe(expected);
  });

  it.each([undefined, "", "javascript:alert(1)", "http://example.com", "mailto:not-an-email", "data:text/html,x"])(
    "hides %p",
    (raw) => {
      expect(resolveContactUrl(raw)).toBeUndefined();
    },
  );
});
