import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TokenResponse } from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api.js";
import { ReenrollmentRequiredError, TokenManager, refreshTokenExpiry } from "./auth.js";
import { writeConfig, type AgentConfig } from "./config.js";
import { silentLogger } from "./logger.js";

const CONFIG: AgentConfig = {
  server: "https://omniralph.example",
  agentId: "0b6f5e0e-8a52-4a4b-9a43-6e8e0c1f9b10",
  refreshToken: "refresh-0",
  workspaceRoot: "/var/lib/omniralph/repos",
};

/** Hands out access-N / refresh-N on each exchange, recording calls in `log`. */
function rotatingExchange(log: string[] = []) {
  let n = 0;
  return vi.fn(async (refreshToken: string): Promise<TokenResponse> => {
    n++;
    log.push(`exchange ${refreshToken}`);
    return { accessToken: `access-${n}`, expiresIn: 900, refreshToken: `refresh-${n}` };
  });
}

function manager(overrides: Partial<ConstructorParameters<typeof TokenManager>[0]> = {}) {
  return new TokenManager({
    config: CONFIG,
    exchange: rotatingExchange(),
    persist: vi.fn(async () => {}),
    logger: silentLogger(),
    ...overrides,
  });
}

describe("TokenManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exchanges the refresh token on start and refreshes at 80% of the TTL", async () => {
    const exchange = rotatingExchange();
    const tokens = manager({ exchange });
    await tokens.start();
    expect(exchange).toHaveBeenCalledWith("refresh-0");
    expect(await tokens.getAccessToken()).toBe("access-1");

    await vi.advanceTimersByTimeAsync(720_000 - 1);
    expect(exchange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(exchange).toHaveBeenCalledTimes(2);
    // The rotated token is presented next, never the used one.
    expect(exchange).toHaveBeenLastCalledWith("refresh-1");
    expect(tokens.currentAccessToken()).toBe("access-2");

    await vi.advanceTimersByTimeAsync(720_000);
    expect(exchange).toHaveBeenLastCalledWith("refresh-2");
    expect(tokens.currentConfig.refreshToken).toBe("refresh-3");
    tokens.stop();
  });

  it("uses the TTL the control panel returns", async () => {
    const exchange = vi.fn(async () => ({ accessToken: "a", expiresIn: 100, refreshToken: "r" }));
    const tokens = manager({ exchange });
    await tokens.start();
    await vi.advanceTimersByTimeAsync(79_999);
    expect(exchange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(exchange).toHaveBeenCalledTimes(2);
    tokens.stop();
  });

  it("persists the rotated refresh token before handing out the new access token", async () => {
    const log: string[] = [];
    let release!: () => void;
    const persist = vi.fn(async (config: AgentConfig) => {
      log.push(`persist ${config.refreshToken}`);
      await new Promise<void>((resolve) => (release = resolve));
      log.push("persisted");
    });
    const tokens = manager({ exchange: rotatingExchange(log), persist });
    const access = tokens.getAccessToken().then((token) => {
      log.push(`use ${token}`);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(["exchange refresh-0", "persist refresh-1"]);
    expect(tokens.currentAccessToken()).toBeNull();
    release();
    await access;
    expect(log).toEqual(["exchange refresh-0", "persist refresh-1", "persisted", "use access-1"]);
    expect(persist).toHaveBeenCalledWith({ ...CONFIG, refreshToken: "refresh-1" });
    tokens.stop();
  });

  it("doesn't use the new access token if persisting fails, and retries with the new refresh token", async () => {
    const exchange = rotatingExchange();
    const persist = vi
      .fn<(config: AgentConfig) => Promise<void>>()
      .mockRejectedValueOnce(new Error("ENOSPC"))
      .mockResolvedValue();
    const tokens = manager({ exchange, persist, retryDelayMs: () => 1_000 });
    await expect(tokens.start()).rejects.toThrow("ENOSPC");
    expect(tokens.currentAccessToken()).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(exchange).toHaveBeenLastCalledWith("refresh-1");
    expect(tokens.currentAccessToken()).toBe("access-2");
    expect(persist).toHaveBeenLastCalledWith({ ...CONFIG, refreshToken: "refresh-2" });
    tokens.stop();
  });

  it("retries transient failures with backoff and honours Retry-After", async () => {
    const exchange = vi
      .fn<(token: string) => Promise<TokenResponse>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new ApiError(429, "rate_limited", "429", 42))
      .mockResolvedValue({ accessToken: "a", expiresIn: 900, refreshToken: "r" });
    const tokens = manager({ exchange });
    await expect(tokens.start()).rejects.toThrow("fetch failed");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exchange).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(41_999);
    expect(exchange).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(exchange).toHaveBeenCalledTimes(3);
    expect(tokens.currentAccessToken()).toBe("a");
    tokens.stop();
  });

  it("shares one exchange between concurrent callers", async () => {
    const exchange = rotatingExchange();
    const tokens = manager({ exchange });
    const [a, b] = await Promise.all([tokens.getAccessToken(), tokens.getAccessToken()]);
    expect(a).toBe("access-1");
    expect(b).toBe("access-1");
    expect(exchange).toHaveBeenCalledTimes(1);
    tokens.stop();
  });

  it("on 401 from /token reports re-enrollment required and stops refreshing", async () => {
    const exchange = rotatingExchange();
    const onFatal = vi.fn();
    const tokens = manager({ exchange, onFatal });
    await tokens.start();
    exchange.mockRejectedValueOnce(new ApiError(401, "refresh_token_reused", "401"));
    await vi.advanceTimersByTimeAsync(720_000);
    expect(onFatal).toHaveBeenCalledTimes(1);
    const error = onFatal.mock.calls[0]![0] as ReenrollmentRequiredError;
    expect(error).toBeInstanceOf(ReenrollmentRequiredError);
    expect(error.message).toBe("re-enrollment required (refresh_token_reused)");
    expect(tokens.currentAccessToken()).toBeNull();
    await expect(tokens.getAccessToken()).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(exchange).toHaveBeenCalledTimes(2);
  });
});

/** A signed-looking refresh token (unverified by the agent) with the given claims. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "EdDSA", typ: "JWT" })}.${part(claims)}.c2lnbmF0dXJl`;
}

describe("refreshTokenExpiry", () => {
  it("reads a signed token's exp claim", () => {
    expect(refreshTokenExpiry(jwt({ sub: CONFIG.agentId, exp: 1_800_000_000 }))).toEqual(
      new Date(1_800_000_000_000),
    );
  });

  it("is null for a legacy opaque token or one that doesn't decode", () => {
    expect(refreshTokenExpiry("orr_legacyopaquetoken")).toBeNull();
    expect(refreshTokenExpiry("a.not-json.c")).toBeNull();
    expect(refreshTokenExpiry(jwt({ sub: CONFIG.agentId }))).toBeNull();
    expect(refreshTokenExpiry(jwt({ exp: "soon" }))).toBeNull();
    expect(refreshTokenExpiry(`a.${Buffer.from("null").toString("base64url")}.c`)).toBeNull();
  });
});

describe("TokenManager.refreshStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-31T10:00:00.000Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is null while refreshes succeed", async () => {
    const tokens = manager();
    expect(tokens.refreshStatus()).toBeNull();
    await tokens.start();
    expect(tokens.refreshStatus()).toBeNull();
    tokens.stop();
  });

  it("tracks the failing streak from its first failure and resets it on success", async () => {
    const refreshToken = jwt({
      sub: CONFIG.agentId,
      exp: Date.parse("2026-11-30T10:00:00Z") / 1000,
    });
    const exchange = vi
      .fn<(token: string) => Promise<TokenResponse>>()
      .mockResolvedValueOnce({ accessToken: "a1", expiresIn: 900, refreshToken })
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new ApiError(503, "unavailable", "503"))
      .mockRejectedValueOnce(new ApiError(429, "rate_limited", "429", 10))
      .mockResolvedValue({ accessToken: "a2", expiresIn: 900, refreshToken: "orr_opaque" });
    const tokens = manager({ exchange });
    await tokens.start();

    // The scheduled refresh at 80% of the TTL fails: the streak starts then.
    await vi.advanceTimersByTimeAsync(720_000);
    expect(tokens.refreshStatus()).toEqual({
      failingSince: "2026-10-31T10:12:00.000Z",
      consecutiveFailures: 1,
      lastError: "network",
      accessTokenExpiresAt: "2026-10-31T10:15:00.000Z",
      refreshTokenExpiresAt: "2026-11-30T10:00:00.000Z",
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(tokens.refreshStatus()).toMatchObject({
      failingSince: "2026-10-31T10:12:00.000Z",
      consecutiveFailures: 2,
      lastError: "http_503",
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(tokens.refreshStatus()).toMatchObject({
      consecutiveFailures: 3,
      lastError: "rate_limited",
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(exchange).toHaveBeenCalledTimes(5);
    expect(tokens.currentAccessToken()).toBe("a2");
    expect(tokens.refreshStatus()).toBeNull();
    tokens.stop();
  });

  it("counts a refresh token that couldn't be saved as a failure", async () => {
    const persist = vi.fn(async () => {}).mockRejectedValueOnce(new Error("EROFS"));
    const tokens = manager({ persist });
    await expect(tokens.start()).rejects.toThrow("EROFS");
    expect(tokens.refreshStatus()).toEqual({
      failingSince: "2026-10-31T10:00:00.000Z",
      consecutiveFailures: 1,
      lastError: "persist_failed",
      // No access token was handed out yet.
      accessTokenExpiresAt: null,
      // The kept (rotated) token is opaque.
      refreshTokenExpiresAt: null,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tokens.refreshStatus()).toBeNull();
    tokens.stop();
  });
});

describe("TokenManager with the config file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-auth-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes each rotated refresh token to agent.json atomically with mode 0600", async () => {
    const file = path.join(dir, "agent.json");
    await writeConfig(file, CONFIG);
    const tokens = new TokenManager({
      config: CONFIG,
      exchange: rotatingExchange(),
      persist: (config) => writeConfig(file, config),
      logger: silentLogger(),
    });
    await tokens.start();
    await tokens.refresh();
    tokens.stop();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      ...CONFIG,
      refreshToken: "refresh-2",
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["agent.json"]);
  });
});
