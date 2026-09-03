/** @jest-environment node */

import {
  constantTimeEqual,
  createCodeChallenge,
  getCognitoWebConfig,
  randomBase64Url,
} from "./cognito-auth";

describe("Cognito PKCE helpers", () => {
  const originals = {
    appOrigin: process.env.APP_ORIGIN,
    clientId: process.env.COGNITO_CLIENT_ID,
    domain: process.env.COGNITO_DOMAIN,
  };

  afterEach(() => {
    for (const [name, value] of Object.entries({
      APP_ORIGIN: originals.appOrigin,
      COGNITO_CLIENT_ID: originals.clientId,
      COGNITO_DOMAIN: originals.domain,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("creates URL-safe random state and an RFC 7636 challenge", async () => {
    const verifier = randomBase64Url(48);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    await expect(createCodeChallenge(verifier)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("compares state without accepting prefixes or length mismatches", () => {
    expect(constantTimeEqual("expected-state", "expected-state")).toBe(true);
    expect(constantTimeEqual("expected-state", "expected-state-extra")).toBe(false);
    expect(constantTimeEqual("expected-state", "Expected-state")).toBe(false);
  });

  it("builds a fixed callback URL from trusted configuration", () => {
    process.env.APP_ORIGIN = "https://signal-room.example";
    process.env.COGNITO_CLIENT_ID = "public-client-id";
    process.env.COGNITO_DOMAIN = "https://signal-room.auth.ap-southeast-1.amazoncognito.com";
    expect(getCognitoWebConfig("https://untrusted-host.test/path")).toEqual({
      clientId: "public-client-id",
      domainOrigin: "https://signal-room.auth.ap-southeast-1.amazoncognito.com",
      redirectUri: "https://signal-room.example/api/auth/callback",
    });
  });

  it("rejects a Cognito URL containing an injected path", () => {
    process.env.COGNITO_CLIENT_ID = "public-client-id";
    process.env.COGNITO_DOMAIN = "https://auth.example/oauth2/authorize";
    expect(() => getCognitoWebConfig("http://localhost:3000")).toThrow(
      "COGNITO_DOMAIN must contain only an origin",
    );
  });
});
