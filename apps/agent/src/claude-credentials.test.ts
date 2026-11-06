import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FetchFn } from "./api.js";
import {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_PROFILE_URL,
  CLAUDE_OAUTH_REDIRECT_URI,
  CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_SIGN_IN_TTL_MS,
  ClaudeSignIn,
  ClaudeSignInError,
  claudeLoginPaths,
  storedLoginChecker,
  storedLoginProblem,
  type ClaudeCredentialsFs,
  type ClaudeLoginPaths,
} from "./claude-credentials.js";

const NOW = Date.parse("2026-11-06T05:00:00.000Z");
const PATHS: ClaudeLoginPaths = {
  credentials: "/home/coder/.claude/.credentials.json",
  globalConfig: "/home/coder/.claude.json",
};

function memoryFs(files: Record<string, unknown> = {}) {
  const store = new Map(
    Object.entries(files).map(([file, value]) => [file, JSON.stringify(value)]),
  );
  const fs: ClaudeCredentialsFs = {
    readFile: async (file) => {
      const text = store.get(file);
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    writePrivateJson: async (file, value) => {
      store.set(file, JSON.stringify(value));
    },
  };
  return { fs, json: (file: string) => JSON.parse(store.get(file) ?? "null") as unknown };
}

describe("claudeLoginPaths", () => {
  it("uses ~/.claude and ~/.claude.json, or CLAUDE_CONFIG_DIR for both", () => {
    expect(claudeLoginPaths({}, "/home/coder")).toEqual(PATHS);
    expect(claudeLoginPaths({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/coder")).toEqual({
      credentials: "/cfg/.credentials.json",
      globalConfig: "/cfg/.claude.json",
    });
  });
});

describe("storedLoginProblem", () => {
  it("finds the login the CLI cleared after a failed refresh", () => {
    expect(storedLoginProblem({ accessToken: "", refreshToken: "", expiresAt: 0 }, NOW)).toBe(
      "Claude's sign-in expired and couldn't be refreshed",
    );
  });

  it("accepts an expired access token while a refresh token can renew it", () => {
    expect(
      storedLoginProblem({ accessToken: "a", refreshToken: "r", expiresAt: NOW - 1 }, NOW),
    ).toBeNull();
    expect(
      storedLoginProblem({ accessToken: "a", refreshToken: "r", expiresAt: NOW + 60_000 }, NOW),
    ).toBeNull();
  });

  it("finds an expired refresh token, or an expired access token with none", () => {
    expect(
      storedLoginProblem(
        { accessToken: "a", refreshToken: "r", expiresAt: NOW - 1, refreshTokenExpiresAt: NOW },
        NOW,
      ),
    ).toBe("Claude's sign-in expired");
    expect(storedLoginProblem({ accessToken: "a", expiresAt: NOW - 1 }, NOW)).toBe(
      "Claude's sign-in expired",
    );
    expect(storedLoginProblem({ accessToken: "a", expiresAt: NOW + 1 }, NOW)).toBeNull();
  });
});

describe("storedLoginChecker", () => {
  it("has nothing to say without a stored login (keychain, env var) or a readable file", async () => {
    expect(await storedLoginChecker({ paths: PATHS, fs: memoryFs().fs })()).toBeNull();
    const broken: ClaudeCredentialsFs = { ...memoryFs().fs, readFile: async () => "{not json" };
    expect(await storedLoginChecker({ paths: PATHS, fs: broken })()).toBeNull();
    const noLogin = memoryFs({ [PATHS.credentials]: { mcpOAuth: {} } });
    expect(await storedLoginChecker({ paths: PATHS, fs: noLogin.fs })()).toBeNull();
  });

  it("reports the cleared login in .credentials.json", async () => {
    const { fs } = memoryFs({
      [PATHS.credentials]: {
        claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] },
      },
    });
    expect(await storedLoginChecker({ paths: PATHS, fs, now: () => NOW })()).toBe(
      "Claude's sign-in expired and couldn't be refreshed",
    );
  });
});

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    token_type: "Bearer",
    access_token: "sk-ant-oat01-new",
    refresh_token: "sk-ant-ort01-new",
    expires_in: 28_800,
    scope: "user:inference user:profile",
    account: { uuid: "acct-1", email_address: "steve@example.com" },
    organization: { uuid: "org-1", name: "Steve's org" },
    ...overrides,
  };
}

function signIn({
  fetch,
  files,
  env = {},
  platform = "linux" as NodeJS.Platform,
}: {
  fetch: FetchFn;
  files?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}) {
  let now = NOW;
  const memory = memoryFs(files);
  const flow = new ClaudeSignIn({
    paths: PATHS,
    fetch,
    fs: memory.fs,
    now: () => now,
    env,
    platform,
  });
  return { flow, ...memory, advance: (ms: number) => (now += ms) };
}

function stubFetch(token: unknown = tokenResponse(), profile: unknown = null) {
  return vi.fn<FetchFn>(async (input) => {
    const url = String(input);
    if (url === CLAUDE_OAUTH_TOKEN_URL) {
      return token instanceof Response ? token : Response.json(token);
    }
    if (url === CLAUDE_OAUTH_PROFILE_URL) {
      return profile === null ? new Response(null, { status: 500 }) : Response.json(profile);
    }
    throw new Error(`unexpected ${url}`);
  });
}

describe("ClaudeSignIn", () => {
  it("starts a PKCE sign-in on the CLI's manual callback", () => {
    const { flow } = signIn({ fetch: stubFetch() });
    const started = flow.start();
    const url = new URL(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize");
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("client_id")).toBe(CLAUDE_OAUTH_CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(CLAUDE_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ")).toContain("user:inference");
    expect(url.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    expect(started.expiresAt).toBe(new Date(NOW + CLAUDE_SIGN_IN_TTL_MS).toISOString());
  });

  it("exchanges CODE#STATE with the verifier and writes the tokens and account, keeping other keys", async () => {
    const fetch = stubFetch(tokenResponse(), {
      account: { uuid: "acct-1", email: "steve@example.com" },
      organization: { uuid: "org-1", organization_type: "claude_max", rate_limit_tier: "tier-5x" },
    });
    const { flow, json } = signIn({
      fetch,
      files: {
        [PATHS.credentials]: {
          claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 },
          mcpOAuth: { server: { token: "keep" } },
        },
        [PATHS.globalConfig]: {
          numStartups: 12,
          oauthAccount: { accountUuid: "acct-1", displayName: "Steve" },
        },
      },
    });
    const url = new URL(flow.start().authorizeUrl);
    const state = url.searchParams.get("state")!;
    const result = await flow.complete(` the-code#${state} `);
    expect(result).toEqual({ email: "steve@example.com", subscriptionType: "max" });

    const [, init] = fetch.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("state")).toBe(state);
    expect(body.get("redirect_uri")).toBe(CLAUDE_OAUTH_REDIRECT_URI);
    const challenge = createHash("sha256").update(body.get("code_verifier")!).digest("base64url");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);

    expect(json(PATHS.credentials)).toEqual({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-new",
        refreshToken: "sk-ant-ort01-new",
        expiresAt: NOW + 28_800_000,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "max",
        rateLimitTier: "tier-5x",
        clientId: CLAUDE_OAUTH_CLIENT_ID,
      },
      mcpOAuth: { server: { token: "keep" } },
    });
    expect(json(PATHS.globalConfig)).toEqual({
      numStartups: 12,
      hasCompletedOnboarding: true,
      oauthAccount: {
        accountUuid: "acct-1",
        displayName: "Steve",
        emailAddress: "steve@example.com",
        organizationUuid: "org-1",
        organizationName: "Steve's org",
      },
    });
    // The code worked once.
    await expect(flow.complete(`the-code#${state}`)).rejects.toThrow("This sign-in expired");
  });

  it("accepts a bare code, and still stores the tokens when the profile can't be read", async () => {
    const { flow, json } = signIn({ fetch: stubFetch() });
    flow.start();
    expect(await flow.complete("the-code")).toEqual({
      email: "steve@example.com",
      subscriptionType: null,
    });
    expect((json(PATHS.credentials) as { claudeAiOauth: object }).claudeAiOauth).toMatchObject({
      accessToken: "sk-ant-oat01-new",
      subscriptionType: null,
    });
  });

  it("refuses a code from another sign-in, an expired sign-in, and none at all", async () => {
    const { flow, advance } = signIn({ fetch: stubFetch() });
    await expect(flow.complete("x#y")).rejects.toThrow("This sign-in expired: start again");
    flow.start();
    await expect(flow.complete("the-code#other")).rejects.toThrow(
      "That code is from another sign-in",
    );
    await expect(flow.complete("#")).rejects.toThrow("Paste the code");
    advance(CLAUDE_SIGN_IN_TTL_MS);
    await expect(flow.complete("the-code")).rejects.toMatchObject({ status: 409 });
  });

  it("says Anthropic didn't accept a rejected code, and forgets that sign-in", async () => {
    const fetch = stubFetch(new Response('{"error":"invalid_grant"}', { status: 400 }));
    const { flow } = signIn({ fetch });
    flow.start();
    const error = await flow.complete("bad").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClaudeSignInError);
    expect((error as ClaudeSignInError).status).toBe(400);
    expect((error as Error).message).toContain("Anthropic didn't accept that code (400)");
    await expect(flow.complete("bad")).rejects.toThrow("This sign-in expired");
  });

  it("keeps the sign-in after a network failure, so the same code can be tried again", async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockImplementation(stubFetch());
    const { flow } = signIn({ fetch });
    flow.start();
    await expect(flow.complete("the-code")).rejects.toThrow("Can't reach Anthropic: fetch failed");
    expect(await flow.complete("the-code")).toMatchObject({ email: "steve@example.com" });
  });

  it("can't help on macOS or while an env var supplies the credentials", () => {
    expect(() => signIn({ fetch: stubFetch(), platform: "darwin" }).flow.start()).toThrow(
      /keychain/,
    );
    expect(() =>
      signIn({ fetch: stubFetch(), env: { ANTHROPIC_API_KEY: "k" } }).flow.start(),
    ).toThrow(/ANTHROPIC_API_KEY is set/);
    expect(() =>
      signIn({ fetch: stubFetch(), env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } }).flow.start(),
    ).toThrow(/CLAUDE_CODE_OAUTH_TOKEN is set/);
  });
});
