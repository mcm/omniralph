import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "./logger.js";
import {
  MODELS_REFRESH_INTERVAL_MS,
  ModelReporter,
  sdkListModels,
  type ListModels,
  type ModelsQueryFn,
} from "./models.js";

const opus: ModelInfo = { value: "opus", displayName: "Opus", description: "Most capable" };
const sonnet: ModelInfo = { value: "sonnet", displayName: "Sonnet", description: "Balanced" };

function reporter(list: ListModels, logger = silentLogger()) {
  let now = 0;
  const models = new ModelReporter({ list, logger, now: () => now });
  return { models, advance: (ms: number) => (now += ms) };
}

describe("ModelReporter", () => {
  it("reads the models at startup, waits for that read, and reports value and display name", async () => {
    const list = vi.fn<ListModels>(async () => [opus, sonnet]);
    const { models } = reporter(list);
    expect(await models.current()).toEqual([
      { value: "opus", displayName: "Opus" },
      { value: "sonnet", displayName: "Sonnet" },
    ]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("reads them again at most once an hour, keeping the last list meanwhile", async () => {
    const list = vi.fn<ListModels>(async () => [opus]);
    const { models, advance } = reporter(list);
    await models.current();
    advance(MODELS_REFRESH_INTERVAL_MS - 1);
    await models.current();
    expect(list).toHaveBeenCalledTimes(1);

    let finish!: (models: ModelInfo[]) => void;
    list.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    advance(1);
    // The hourly read runs in the background: the heartbeat isn't held up.
    expect(await models.current()).toEqual([{ value: "opus", displayName: "Opus" }]);
    expect(await models.current()).toEqual([{ value: "opus", displayName: "Opus" }]);
    expect(list).toHaveBeenCalledTimes(2);
    finish([sonnet]);
    await vi.waitFor(async () =>
      expect(await models.current()).toEqual([{ value: "sonnet", displayName: "Sonnet" }]),
    );
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("reports none when a read fails and logs the reason once until a read succeeds", async () => {
    const logger = silentLogger();
    const warn = vi.spyOn(logger, "warn");
    const list = vi.fn<ListModels>(async () => {
      throw new Error("not logged in");
    });
    const { models, advance } = reporter(list, logger);
    expect(await models.current()).toEqual([]);
    advance(MODELS_REFRESH_INTERVAL_MS);
    await models.current();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: "not logged in" }) },
      expect.any(String),
    );

    list.mockResolvedValueOnce([opus]);
    advance(MODELS_REFRESH_INTERVAL_MS);
    await models.current();
    await vi.waitFor(async () => expect(await models.current()).toHaveLength(1));
    list.mockRejectedValueOnce(new Error("logged out"));
    advance(MODELS_REFRESH_INTERVAL_MS);
    await models.current();
    await vi.waitFor(async () => expect(await models.current()).toEqual([]));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("gives up on a read that hangs", async () => {
    const list = vi.fn<ListModels>(() => new Promise(() => {}));
    const models = new ModelReporter({ list, logger: silentLogger(), readTimeoutMs: 10 });
    expect(await models.current()).toEqual([]);
  });

  it("drops models without a value and falls back to the value as display name", async () => {
    const { models } = reporter(async () => [
      { value: "", displayName: "Nothing", description: "" },
      { value: "haiku", displayName: "", description: "" },
    ]);
    expect(await models.current()).toEqual([{ value: "haiku", displayName: "haiku" }]);
  });
});

describe("sdkListModels", () => {
  it("asks an idle session without tools or settings for its models, then closes it", async () => {
    const close = vi.fn();
    const calls: Parameters<ModelsQueryFn>[0][] = [];
    const query: ModelsQueryFn = (params) => {
      calls.push(params);
      return { supportedModels: async () => [opus], close };
    };
    const list = sdkListModels(query, { HOME: "/home/agent" });
    expect(await list(new AbortController().signal)).toEqual([opus]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(calls[0]?.options).toMatchObject({
      tools: [],
      settingSources: [],
      persistSession: false,
      env: { HOME: "/home/agent", CLAUDE_AGENT_SDK_CLIENT_APP: "omniralph-agent" },
    });
    // The prompt never sends a message: it ends when the session is closed.
    expect(await calls[0]!.prompt[Symbol.asyncIterator]().next()).toEqual({
      value: undefined,
      done: true,
    });
  });

  it("closes the session when reading fails and aborts it with the signal", async () => {
    const close = vi.fn();
    let aborted: AbortSignal | undefined;
    const query: ModelsQueryFn = ({ options }) => {
      aborted = options.abortController.signal;
      return {
        supportedModels: () =>
          new Promise((_, reject) =>
            aborted!.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
        close,
      };
    };
    const controller = new AbortController();
    const reading = sdkListModels(query, {})(controller.signal);
    controller.abort();
    await expect(reading).rejects.toThrow("aborted");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
