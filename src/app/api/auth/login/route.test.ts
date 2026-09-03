/** @jest-environment node */

import { GET } from "./route";

describe("GET /api/auth/login", () => {
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

  it("starts Cognito authorization code flow with PKCE and HttpOnly state", async () => {
    process.env.APP_ORIGIN = "http://localhost:3000";
    process.env.COGNITO_CLIENT_ID = "public-client";
    process.env.COGNITO_DOMAIN = "http://localhost:4567";

    const response = await GET(new Request("http://localhost:3000/api/auth/login"));
    const location = new URL(response.headers.get("location")!);
    const cookies = response.headers.getSetCookie().join(";");

    expect(location.origin).toBe("http://localhost:4567");
    expect(location.pathname).toBe("/oauth2/authorize");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback");
    expect(cookies).toContain("signal-room-oauth-state=");
    expect(cookies).toContain("signal-room-oauth-verifier=");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("SameSite=lax");
    expect(cookies).not.toContain("access_token");
  });

  it("returns a safe error when Cognito is not configured", async () => {
    delete process.env.COGNITO_CLIENT_ID;
    delete process.env.COGNITO_DOMAIN;
    const response = await GET(new Request("http://localhost:3000/api/auth/login"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/undefined|COGNITO_/);
  });
});
