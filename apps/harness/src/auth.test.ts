import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TokenResponse } from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api.js";
import { ReenrollmentRequiredError, TokenManager } from "./auth.js";
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

describe("TokenManager with the config file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-auth-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes each rotated refresh token to harness.json atomically with mode 0600", async () => {
    const file = path.join(dir, "harness.json");
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
    expect(await readdir(dir)).toEqual(["harness.json"]);
  });
});
