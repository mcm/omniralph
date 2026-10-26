/**
 * The Claude models the agent's login can run, from the Agent SDK's
 * `Query.supportedModels()`, reported in every heartbeat so the control
 * panel's model pickers only offer models an agent can actually run.
 */
import { query as sdkQuery, type ModelInfo, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Heartbeat } from "@omniralph/shared";
import type { Logger } from "./logger.js";
import { InputQueue } from "./session/session.js";

/** How often the models are read again after startup. */
export const MODELS_REFRESH_INTERVAL_MS = 60 * 60_000;

/** A read of the models that takes longer than this fails. */
export const MODELS_READ_TIMEOUT_MS = 60_000;

/** Reads the models the host's Claude login can run. */
export type ListModels = (signal: AbortSignal) => Promise<readonly ModelInfo[]>;

/** The SDK's `query()`, as `sdkListModels` calls it. */
export type ModelsQueryFn = (params: {
  prompt: AsyncIterable<never>;
  options: { abortController: AbortController } & Record<string, unknown>;
}) => Pick<Query, "supportedModels" | "close">;

/**
 * A `ListModels` on the SDK: an idle streaming session (no prompt, no tools,
 * no settings) asked for `supportedModels()`, then closed.
 */
export function sdkListModels(
  query: ModelsQueryFn = sdkQuery as unknown as ModelsQueryFn,
  env: NodeJS.ProcessEnv = process.env,
): ListModels {
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
      return await session.supportedModels();
    } finally {
      signal.removeEventListener("abort", abort);
      input.close();
      session.close();
    }
  };
}

export interface ModelReporterOptions {
  list: ListModels;
  logger: Logger;
  refreshIntervalMs?: number;
  readTimeoutMs?: number;
  now?: () => number;
}

/**
 * Keeps the models to report: read on the first heartbeat (which waits for
 * it), then again in the background at most once per `refreshIntervalMs`.
 * A failed read reports none and logs its reason once, until a read succeeds.
 */
export class ModelReporter {
  private models: Heartbeat["models"] = [];
  private readAt: number | null = null;
  private reading: Promise<void> | null = null;
  private failing = false;
  private everRead = false;

  constructor(private readonly options: ModelReporterOptions) {}

  /** The models to report in a heartbeat. */
  async current(): Promise<Heartbeat["models"]> {
    const now = (this.options.now ?? Date.now)();
    const interval = this.options.refreshIntervalMs ?? MODELS_REFRESH_INTERVAL_MS;
    if (this.reading === null && (this.readAt === null || now - this.readAt >= interval)) {
      this.readAt = now;
      this.reading = this.read().finally(() => {
        this.reading = null;
      });
    }
    // Only the startup read is waited for; later ones keep the last list until done.
    if (this.reading !== null && !this.everRead) await this.reading;
    return this.models;
  }

  private async read(): Promise<void> {
    const timeout = AbortSignal.timeout(this.options.readTimeoutMs ?? MODELS_READ_TIMEOUT_MS);
    try {
      const models = await Promise.race([
        this.options.list(timeout),
        new Promise<never>((_, reject) =>
          timeout.addEventListener("abort", () => reject(new Error("timed out reading models")), {
            once: true,
          }),
        ),
      ]);
      this.models = models
        .filter((model) => model.value.length > 0)
        .slice(0, 100)
        .map((model) => ({
          value: model.value.slice(0, 200),
          displayName: (model.displayName || model.value).slice(0, 200),
        }));
      this.failing = false;
    } catch (error) {
      this.models = [];
      if (!this.failing) {
        this.options.logger.warn({ err: error }, "cannot read the models Claude can run");
      }
      this.failing = true;
    } finally {
      this.everRead = true;
    }
  }
}
