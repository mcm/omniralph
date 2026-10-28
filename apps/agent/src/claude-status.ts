/**
 * Whether Claude is signed in on the agent, with what, and which models it
 * can run: the Agent SDK's `Query.accountInfo()` and `Query.supportedModels()`
 * on one idle session. The heartbeat reports the models (so the control
 * panel's model pickers only offer models an agent can run) and the login
 * state without the account; the agent's page shows all of it.
 */
import { EventEmitter } from "node:events";
import {
  query as sdkQuery,
  type AccountInfo,
  type ModelInfo,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeLoginReport,
  ClaudeLoginSource,
  ClaudeLoginStatus,
  ReportedModel,
} from "@omniralph/shared";
import type { Logger } from "./logger.js";
import { InputQueue } from "./session/session.js";

/** How often Claude is checked again after startup. */
export const CLAUDE_STATUS_REFRESH_INTERVAL_MS = 60 * 60_000;

/** A check that takes longer than this gives up: the state is `unknown`. */
export const CLAUDE_STATUS_READ_TIMEOUT_MS = 60_000;

/** "Check again" reads at most once in this long. */
export const CLAUDE_STATUS_CHECK_MIN_INTERVAL_MS = 10_000;

/** What one read of the SDK session returns. */
export interface ClaudeRead {
  models: readonly ModelInfo[];
  account: AccountInfo;
}

/** Reads the host's Claude login and the models it can run. */
export type ReadClaude = (signal: AbortSignal) => Promise<ClaudeRead>;

/** The SDK's `query()`, as `sdkReadClaude` calls it. */
export type ClaudeQueryFn = (params: {
  prompt: AsyncIterable<never>;
  options: { abortController: AbortController } & Record<string, unknown>;
}) => Pick<Query, "supportedModels" | "accountInfo" | "close">;

/**
 * A `ReadClaude` on the SDK: an idle streaming session (no prompt, no tools,
 * no settings) asked for its models and account, then closed.
 */
export function sdkReadClaude(
  query: ClaudeQueryFn = sdkQuery as unknown as ClaudeQueryFn,
  env: NodeJS.ProcessEnv = process.env,
): ReadClaude {
  return async (signal) => {
    const input = new InputQueue();
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener("abort", abort, { once: true });
    const session = query({
      prompt: input as AsyncIterable<never>,
      options: {
        abortController,
        tools: [],
        settingSources: [],
        persistSession: false,
        env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: "omniralph-agent" },
      },
    });
    try {
      const [models, account] = await Promise.all([
        session.supportedModels(),
        session.accountInfo(),
      ]);
      return { models, account };
    } finally {
      signal.removeEventListener("abort", abort);
      input.close();
      session.close();
    }
  };
}

/** The signed-in account, shown on the agent's page only: it never leaves the machine. */
export interface ClaudeAccount {
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
}

/** What the last check found. */
export interface ClaudeStatus {
  status: ClaudeLoginStatus;
  /** Where the credentials come from; null unless signed in. */
  source: ClaudeLoginSource | null;
  /** Only when signed in. */
  account?: ClaudeAccount;
  /** The models the login can run; none unless signed in. */
  models: ReportedModel[];
  /** ISO time of the check. */
  checkedAt: string;
  /** Why the check didn't find a working login. */
  error?: string;
}

/**
 * Where the credentials come from: an `ANTHROPIC_API_KEY`, a
 * `CLAUDE_CODE_OAUTH_TOKEN`, the `claude` CLI's login (first party), or a
 * third-party provider (Bedrock, Vertex, a gateway…).
 */
export function claudeLoginSource(account: AccountInfo): ClaudeLoginSource {
  if (account.apiKeySource?.includes("ANTHROPIC_API_KEY")) return "api_key";
  if (account.tokenSource?.includes("CLAUDE_CODE_OAUTH_TOKEN")) return "oauth_token";
  if (account.apiProvider === undefined || account.apiProvider === "firstParty") return "login";
  return "other";
}

/** Whether a failed read means there is no working login (rather than some other failure). */
export function isClaudeAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authenticat|not logged in|log ?in|\/login|unauthori[sz]ed|\b401\b|invalid api key|credential/i.test(
    message,
  );
}

export interface ClaudeStatusReporterOptions {
  read: ReadClaude;
  logger: Logger;
  refreshIntervalMs?: number;
  readTimeoutMs?: number;
  checkMinIntervalMs?: number;
  now?: () => number;
}

class ReadTimeout extends Error {
  constructor() {
    super("timed out checking Claude");
  }
}

/**
 * Keeps Claude's login state and models: read on the first heartbeat (which
 * waits for it), then again in the background at most once per
 * `refreshIntervalMs`, and at once on `check()` ("Check again"). A failed
 * read logs its reason once, until a read succeeds. Emits `change` with the
 * new `ClaudeStatus` after every read.
 */
export class ClaudeStatusReporter extends EventEmitter<{ change: [ClaudeStatus] }> {
  private last: ClaudeStatus | null = null;
  private readAt: number | null = null;
  private reading: Promise<ClaudeStatus> | null = null;
  private failing = false;

  constructor(private readonly options: ClaudeStatusReporterOptions) {
    super();
  }

  /** The last check's result; null before the first one finished. */
  status(): ClaudeStatus | null {
    return this.last;
  }

  /**
   * The state to report in a heartbeat. Starts the hourly read when due; only
   * the first one is waited for, later ones keep the last state until done.
   */
  async current(): Promise<ClaudeStatus> {
    const interval = this.options.refreshIntervalMs ?? CLAUDE_STATUS_REFRESH_INTERVAL_MS;
    if (this.reading === null && (this.readAt === null || this.now() - this.readAt >= interval)) {
      this.start();
    }
    if (this.last === null) return this.reading!;
    return this.last;
  }

  /**
   * Checks again at once ("Check again"): a read already running is shared,
   * and one that started less than `checkMinIntervalMs` ago answers instead.
   */
  async check(): Promise<ClaudeStatus> {
    if (this.reading !== null) return this.reading;
    const minInterval = this.options.checkMinIntervalMs ?? CLAUDE_STATUS_CHECK_MIN_INTERVAL_MS;
    if (this.last !== null && this.readAt !== null && this.now() - this.readAt < minInterval) {
      return this.last;
    }
    return this.start();
  }

  /** The heartbeat's `claude`: the state without the account. */
  static report(status: ClaudeStatus): ClaudeLoginReport {
    return { status: status.status, source: status.source, checkedAt: status.checkedAt };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private start(): Promise<ClaudeStatus> {
    this.readAt = this.now();
    const reading = this.read().finally(() => {
      this.reading = null;
    });
    this.reading = reading;
    return reading;
  }

  private async read(): Promise<ClaudeStatus> {
    const checkedAt = new Date(this.now()).toISOString();
    const timeout = AbortSignal.timeout(
      this.options.readTimeoutMs ?? CLAUDE_STATUS_READ_TIMEOUT_MS,
    );
    let status: ClaudeStatus;
    try {
      const { models, account } = await Promise.race([
        this.options.read(timeout),
        new Promise<never>((_, reject) =>
          timeout.addEventListener("abort", () => reject(new ReadTimeout()), { once: true }),
        ),
      ]);
      const reported = models
        .filter((model) => model.value.length > 0)
        .slice(0, 100)
        .map((model) => ({
          value: model.value.slice(0, 200),
          displayName: (model.displayName || model.value).slice(0, 200),
        }));
      status =
        reported.length === 0
          ? {
              status: "signed_out",
              source: null,
              models: [],
              checkedAt,
              error: "Claude reported no models it can run",
            }
          : {
              status: "signed_in",
              source: claudeLoginSource(account),
              account: {
                email: account.email ?? null,
                organization: account.organization ?? null,
                subscriptionType: account.subscriptionType ?? null,
              },
              models: reported,
              checkedAt,
            };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status = {
        status: error instanceof ReadTimeout || timeout.aborted ? "unknown" : signedOutOr(error),
        source: null,
        models: [],
        checkedAt,
        error: message.slice(0, 2000),
      };
    }
    if (status.status === "signed_in") {
      this.failing = false;
    } else {
      if (!this.failing) {
        this.options.logger.warn(
          { status: status.status, error: status.error },
          "Claude isn't signed in or can't be checked",
        );
      }
      this.failing = true;
    }
    this.last = status;
    this.emit("change", status);
    return status;
  }
}

function signedOutOr(error: unknown): ClaudeLoginStatus {
  return isClaudeAuthError(error) ? "signed_out" : "unknown";
}
