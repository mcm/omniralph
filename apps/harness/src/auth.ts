import type { TokenResponse } from "@omniralph/shared";
import { ApiError } from "./api.js";
import type { HarnessConfig } from "./config.js";
import type { Logger } from "./logger.js";

/** The control panel rejected the refresh token: the agent was revoked or a reuse was detected. */
export class ReenrollmentRequiredError extends Error {
  override name = "ReenrollmentRequiredError";
  constructor(readonly code: string | undefined) {
    super(`re-enrollment required${code ? ` (${code})` : ""}`);
  }
}

export interface TokenManagerOptions {
  config: HarnessConfig;
  /** `POST /api/harness/token`. */
  exchange: (refreshToken: string) => Promise<TokenResponse>;
  /** Persists the config atomically (see `writeConfig`). */
  persist: (config: HarnessConfig) => Promise<void>;
  logger: Logger;
  /** Called once when the refresh token is rejected (401); the daemon stops and exits non-zero. */
  onFatal?: (error: ReenrollmentRequiredError) => void;
  /** Fraction of the access token's TTL after which it is refreshed. */
  refreshAt?: number;
  /** Delay before retrying a failed refresh (network error, 5xx, 429 without Retry-After). */
  retryDelayMs?: (failures: number) => number;
}

const defaultRetryDelayMs = (failures: number) => Math.min(60_000, 5_000 * 2 ** (failures - 1));

/**
 * Holds the agent's access token and rotates the refresh token.
 *
 * Every exchange at `/api/harness/token` consumes the presented refresh token,
 * and presenting it again revokes the agent. So the new refresh token is
 * written to the config file (atomically) before the new access token is
 * handed out: a crash can't leave the agent with only a used token.
 *
 * These tokens never leave this process: job subprocesses only get their job
 * token (see `job-env.ts`).
 */
export class TokenManager {
  private config: HarnessConfig;
  private accessToken: string | null = null;
  private expiresAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<string> | null = null;
  private failures = 0;
  private fatal: ReenrollmentRequiredError | null = null;
  private stopped = false;
  private readonly refreshAt: number;
  private readonly retryDelayMs: (failures: number) => number;

  constructor(private readonly options: TokenManagerOptions) {
    this.config = options.config;
    this.refreshAt = options.refreshAt ?? 0.8;
    this.retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  }

  /** Obtains the first access token. Rejects on a 401 (and calls `onFatal`). */
  async start(): Promise<void> {
    await this.refresh();
  }

  /** The current config, including the latest refresh token. */
  get currentConfig(): HarnessConfig {
    return this.config;
  }

  /** The current access token without waiting (for per-request header injection). */
  currentAccessToken(): string | null {
    return this.fatal ? null : this.accessToken;
  }

  /** A valid access token, refreshing first if the current one has (nearly) expired. */
  async getAccessToken(): Promise<string> {
    if (this.fatal) throw this.fatal;
    if (this.accessToken && Date.now() < this.expiresAt - 5_000) return this.accessToken;
    return this.refresh();
  }

  /** Refreshes now (concurrent callers share one exchange). */
  refresh(): Promise<string> {
    if (this.fatal) return Promise.reject(this.fatal);
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private async doRefresh(): Promise<string> {
    this.clearTimer();
    let response: TokenResponse;
    try {
      response = await this.options.exchange(this.config.refreshToken);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.fatal = new ReenrollmentRequiredError(error.code);
        this.accessToken = null;
        this.stop();
        this.options.logger.fatal(
          { code: error.code },
          "re-enrollment required: the control panel rejected the refresh token",
        );
        this.options.onFatal?.(this.fatal);
        throw this.fatal;
      }
      this.failures++;
      const delay =
        error instanceof ApiError && error.retryAfterSeconds
          ? error.retryAfterSeconds * 1000
          : this.retryDelayMs(this.failures);
      this.options.logger.warn({ err: error, retryInMs: delay }, "access token refresh failed");
      this.schedule(delay);
      throw error;
    }

    // The presented token is used up now: keep the new one in memory even if persisting fails,
    // so the next attempt doesn't present the old one (which would revoke the agent).
    this.config = { ...this.config, refreshToken: response.refreshToken };
    try {
      await this.options.persist(this.config);
    } catch (error) {
      this.failures++;
      const delay = this.retryDelayMs(this.failures);
      this.options.logger.error(
        { err: error, retryInMs: delay },
        "could not persist the rotated refresh token; not using the new access token",
      );
      this.schedule(delay);
      throw error;
    }

    this.failures = 0;
    this.accessToken = response.accessToken;
    this.expiresAt = Date.now() + response.expiresIn * 1000;
    this.schedule(response.expiresIn * 1000 * this.refreshAt);
    this.options.logger.debug({ expiresIn: response.expiresIn }, "access token refreshed");
    return response.accessToken;
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // Failures are logged and rescheduled by doRefresh.
      this.refresh().catch(() => {});
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
