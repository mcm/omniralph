import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  authorizeUrl,
  createOAuthState,
  exchangeCode,
  LinearOAuthError,
  linearOAuthConfig,
  refreshCredentials,
  verifyOAuthState,
} = await import("./oauth");

const env = { AUTH_SECRET: "test-auth-secret" } as unknown as NodeJS.ProcessEnv;
const config = { clientId: "client-1", clientSecret: "secret-1" };
const tokenRequests: URLSearchParams[] = [];
let tokenResponse: () => Response = () =>
  HttpResponse.json({
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "read,write,app:assignable,app:mentionable",
  });

const server = setupServer(
  http.post("https://api.linear.app/oauth/token", async ({ request }) => {
    tokenRequests.push(new URLSearchParams(await request.text()));
    return tokenResponse();
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  tokenRequests.length = 0;
});
afterAll(() => server.close());

describe("authorizeUrl", () => {
  it("asks for an app actor with the agent scopes", () => {
    const url = new URL(authorizeUrl("client-1", "https://o.example.com/cb", "signed"));
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-1",
      redirect_uri: "https://o.example.com/cb",
      response_type: "code",
      scope: "read,write,app:assignable,app:mentionable",
      actor: "app",
      state: "signed",
      prompt: "consent",
    });
  });
});

describe("linearOAuthConfig", () => {
  it("needs both the client ID and secret", () => {
    expect(linearOAuthConfig({ LINEAR_CLIENT_ID: "a" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(
      linearOAuthConfig({
        LINEAR_CLIENT_ID: "a",
        LINEAR_CLIENT_SECRET: "b",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({ clientId: "a", clientSecret: "b" });
  });
});

describe("OAuth state", () => {
  it("verifies for the same user and nonce only", async () => {
    const { state, nonce } = await createOAuthState("admin-1", env);
    expect(await verifyOAuthState(state, { userId: "admin-1", nonce }, env)).toBe(true);
    expect(await verifyOAuthState(state, { userId: "admin-2", nonce }, env)).toBe(false);
    expect(await verifyOAuthState(state, { userId: "admin-1", nonce: "other" }, env)).toBe(false);
    expect(await verifyOAuthState(state, { userId: "admin-1", nonce: undefined }, env)).toBe(false);
  });

  it("rejects missing, tampered, foreign-key and expired states", async () => {
    const { state, nonce } = await createOAuthState("admin-1", env);
    const expect_ = { userId: "admin-1", nonce };
    expect(await verifyOAuthState(null, expect_, env)).toBe(false);
    expect(await verifyOAuthState("", expect_, env)).toBe(false);
    expect(await verifyOAuthState("not-a-jwt", expect_, env)).toBe(false);
    expect(await verifyOAuthState(`${state.slice(0, -2)}xx`, expect_, env)).toBe(false);
    const other = { AUTH_SECRET: "other-secret" } as unknown as NodeJS.ProcessEnv;
    expect(await verifyOAuthState(state, expect_, other)).toBe(false);

    vi.useFakeTimers({ now: Date.now() + 11 * 60 * 1000 });
    try {
      expect(await verifyOAuthState(state, expect_, env)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("token endpoint", () => {
  it("exchanges a code for credentials with an absolute expiry", async () => {
    const now = Date.parse("2026-10-06T00:00:00Z");
    const credentials = await exchangeCode(config, {
      code: "code-1",
      redirectUri: "https://o.example.com/cb",
      now,
    });
    expect(credentials).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: "2026-10-06T01:00:00.000Z",
      scope: "read,write,app:assignable,app:mentionable",
    });
    expect(Object.fromEntries(tokenRequests[0]!)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "https://o.example.com/cb",
      client_id: "client-1",
      client_secret: "secret-1",
    });
  });

  it("refreshes, keeping the refresh token when Linear doesn't rotate it", async () => {
    tokenResponse = () =>
      HttpResponse.json({ access_token: "access-2", expires_in: 60, token_type: "Bearer" });
    const now = Date.parse("2026-10-06T00:00:00Z");
    const refreshed = await refreshCredentials(
      config,
      { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: "x" },
      now,
    );
    expect(refreshed).toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-1",
      expiresAt: "2026-10-06T00:01:00.000Z",
    });
    expect(tokenRequests[0]?.get("grant_type")).toBe("refresh_token");
    expect(tokenRequests[0]?.get("refresh_token")).toBe("refresh-1");
  });

  it("reports token endpoint errors", async () => {
    tokenResponse = () => HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    await expect(
      exchangeCode(config, { code: "bad", redirectUri: "https://o.example.com/cb" }),
    ).rejects.toBeInstanceOf(LinearOAuthError);
  });
});
