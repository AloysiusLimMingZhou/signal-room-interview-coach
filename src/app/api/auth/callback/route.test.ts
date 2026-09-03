/** @jest-environment node */

import { NextRequest } from "next/server";
import { GET } from "./route";

describe("GET /api/auth/callback", () => {
  const originals = {
    appOrigin: process.env.APP_ORIGIN,
    clientId: process.env.COGNITO_CLIENT_ID,
    domain: process.env.COGNITO_DOMAIN,
  };

  beforeEach(() => {
    process.env.APP_ORIGIN = "http://localhost:3000";
    process.env.COGNITO_CLIENT_ID = "public-client";
    process.env.COGNITO_DOMAIN = "http://localhost:4567";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const [name, value] of Object.entries({
      APP_ORIGIN: originals.appOrigin,
      COGNITO_CLIENT_ID: originals.clientId,
      COGNITO_DOMAIN: originals.domain,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("rejects a state mismatch before calling the token endpoint", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const request = new NextRequest(
      "http://localhost:3000/api/auth/callback?code=one-time-code&state=attacker-state",
      { headers: { Cookie: "signal-room-oauth-state=expected-state; signal-room-oauth-verifier=verifier" } },
    );

    const response = await GET(request);
    expect(response.headers.get("location")).toBe("http://localhost:3000/?auth=failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stores only the access token in a scoped HttpOnly cookie", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      access_token: "a".repeat(64),
      expires_in: 3_600,
      token_type: "Bearer",
      refresh_token: "refresh-token-must-not-be-stored",
      id_token: "id-token-must-not-be-stored",
    }));
    const request = new NextRequest(
      "http://localhost:3000/api/auth/callback?code=one-time-code&state=expected-state",
      { headers: { Cookie: "signal-room-oauth-state=expected-state; signal-room-oauth-verifier=verifier" } },
    );

    const response = await GET(request);
    const cookies = response.headers.getSetCookie().join(";");
    expect(response.headers.get("location")).toBe("http://localhost:3000/?auth=success");
    expect(cookies).toContain("signal-room-access=");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("Path=/api");
    expect(cookies).not.toContain("refresh-token-must-not-be-stored");
    expect(cookies).not.toContain("id-token-must-not-be-stored");
  });
});
