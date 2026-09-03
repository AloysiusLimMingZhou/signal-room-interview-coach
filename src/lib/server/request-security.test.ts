/** @jest-environment node */

import {
  RequestValidationError,
  hasTrustedOrigin,
  readJsonBody,
  resolveAppOrigin,
} from "./request-security";

describe("request security helpers", () => {
  const originalAppOrigin = process.env.APP_ORIGIN;
  const originalP1ApiUrl = process.env.P1_API_URL;

  afterEach(() => {
    if (originalAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = originalAppOrigin;
    if (originalP1ApiUrl === undefined) delete process.env.P1_API_URL;
    else process.env.P1_API_URL = originalP1ApiUrl;
  });

  it("parses a bounded JSON body", async () => {
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });
    await expect(readJsonBody(request, 64)).resolves.toEqual({ ok: true });
  });

  it("rejects malformed and oversized bodies", async () => {
    await expect(
      readJsonBody(new Request("http://localhost", { method: "POST", body: "{" }), 64),
    ).rejects.toBeInstanceOf(RequestValidationError);

    await expect(
      readJsonBody(
        new Request("http://localhost", {
          method: "POST",
          headers: { "Content-Length": "500" },
          body: "{}",
        }),
        64,
      ),
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("requires an exact same-origin value", () => {
    process.env.APP_ORIGIN = "https://signal-room.example";
    expect(
      hasTrustedOrigin(
        new Request("https://signal-room.example/api/test", {
          headers: { Origin: "https://signal-room.example" },
        }),
      ),
    ).toBe(true);
    expect(
      hasTrustedOrigin(
        new Request("https://signal-room.example/api/test", {
          headers: { Origin: "https://signal-room.example.attacker.test" },
        }),
      ),
    ).toBe(false);
    expect(hasTrustedOrigin(new Request("https://signal-room.example/api/test"))).toBe(false);
  });

  it("rejects insecure configured origins", () => {
    process.env.APP_ORIGIN = "http://signal-room.example";
    expect(() => resolveAppOrigin("https://signal-room.example/api/test")).toThrow(
      "APP_ORIGIN must use HTTPS",
    );
  });
});
