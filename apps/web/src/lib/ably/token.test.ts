import { decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ABLY_TOKEN_TTL_SECONDS, getAblyConfig, heartbeatAblyToken, signAblyToken } from "./token";

const AGENT_ID = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";
const ORG_ID = "0b7d9a2e-4c1f-4e8a-9b3d-5f6a7b8c9d0e";
const CONFIG = { keyName: "appId.keyId", keySecret: "s3cr3t-key-secret" };
const NOW = Date.parse("2026-10-15T12:00:00.000Z");

describe("getAblyConfig", () => {
  it("splits ABLY_API_KEY into the key name and secret", () => {
    expect(getAblyConfig({ ABLY_API_KEY: "appId.keyId:se:cret" })).toEqual({
      keyName: "appId.keyId",
      keySecret: "se:cret",
    });
  });

  it("turns Ably off when the key is unset or blank", () => {
    expect(getAblyConfig({})).toBeNull();
    expect(getAblyConfig({ ABLY_API_KEY: " " })).toBeNull();
  });

  it("turns Ably off when the key is malformed", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const ABLY_API_KEY of ["no-colon", ":secret", "name:"]) {
      expect(getAblyConfig({ ABLY_API_KEY })).toBeNull();
    }
    expect(error).toHaveBeenCalledTimes(3);
    error.mockRestore();
  });
});

describe("signAblyToken", () => {
  it("signs a subscribe-only HS256 JWT for the agent's wake channels", async () => {
    const { token, expiresAt } = await signAblyToken(CONFIG, {
      agentId: AGENT_ID,
      organizationId: ORG_ID,
      now: NOW,
    });
    expect(decodeProtectedHeader(token)).toEqual({ alg: "HS256", typ: "JWT", kid: CONFIG.keyName });
    const { payload } = await jwtVerify(token, new TextEncoder().encode(CONFIG.keySecret), {
      algorithms: ["HS256"],
      currentDate: new Date(NOW),
    });
    const iat = NOW / 1000;
    expect(payload).toEqual({
      iat,
      exp: iat + ABLY_TOKEN_TTL_SECONDS,
      "x-ably-clientId": AGENT_ID,
      "x-ably-capability": expect.any(String),
    });
    expect(ABLY_TOKEN_TTL_SECONDS).toBe(12 * 60 * 60);
    expect(JSON.parse(payload["x-ably-capability"] as string)).toEqual({
      [`agent:${AGENT_ID}`]: ["subscribe"],
      [`org:${ORG_ID}`]: ["subscribe"],
    });
    expect(expiresAt).toBe("2026-10-16T00:00:00.000Z");
  });

  it("can't be verified with another secret", async () => {
    const { token } = await signAblyToken(CONFIG, {
      agentId: AGENT_ID,
      organizationId: ORG_ID,
    });
    await expect(jwtVerify(token, new TextEncoder().encode("other"))).rejects.toThrow();
  });
});

describe("heartbeatAblyToken", () => {
  const input = { agentId: AGENT_ID, organizationId: ORG_ID, now: NOW };
  const inMinutes = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

  it("is null when Ably is off", async () => {
    expect(await heartbeatAblyToken(null, { ...input, tokenExpiresAt: undefined })).toBeNull();
    expect(await heartbeatAblyToken(null, { ...input, tokenExpiresAt: inMinutes(5) })).toBeNull();
  });

  it("issues a token when the agent has none", async () => {
    const ably = await heartbeatAblyToken(CONFIG, { ...input, tokenExpiresAt: undefined });
    expect(ably?.expiresAt).toBe(new Date(NOW + ABLY_TOKEN_TTL_SECONDS * 1000).toISOString());
  });

  it("issues a token when the agent's expires within the hour", async () => {
    for (const minutes of [59, 0, -30]) {
      const ably = await heartbeatAblyToken(CONFIG, {
        ...input,
        tokenExpiresAt: inMinutes(minutes),
      });
      expect(ably?.token).toEqual(expect.any(String));
    }
  });

  it("issues nothing while the agent's token is good for another hour", async () => {
    for (const minutes of [60, 61, 720]) {
      expect(
        await heartbeatAblyToken(CONFIG, { ...input, tokenExpiresAt: inMinutes(minutes) }),
      ).toBeUndefined();
    }
  });
});
