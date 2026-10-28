import type { AccountInfo, ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_STATUS_CHECK_MIN_INTERVAL_MS,
  CLAUDE_STATUS_REFRESH_INTERVAL_MS,
  ClaudeStatusReporter,
  sdkReadClaude,
  type ClaudeQueryFn,
  type ClaudeRead,
  type ClaudeStatus,
  type ReadClaude,
} from "./claude-status.js";
import { silentLogger } from "./logger.js";

const opus: ModelInfo = { value: "opus", displayName: "Opus", description: "Most capable" };
const sonnet: ModelInfo = { value: "sonnet", displayName: "Sonnet", description: "Balanced" };

const START = Date.parse("2026-10-28T10:00:00.000Z");

const firstParty: AccountInfo = {
  email: "steve@example.com",
  organization: "Example",
  subscriptionType: "max",
  tokenSource: "claude.ai",
  apiProvider: "firstParty",
};

function read(account: AccountInfo, models: ModelInfo[] = [opus]): ClaudeRead {
  return { models, account };
}

function reporter(readClaude: ReadClaude, logger = silentLogger()) {
  let now = START;
  const claude = new ClaudeStatusReporter({ read: readClaude, logger, now: () => now });
  return { claude, advance: (ms: number) => (now += ms) };
}

describe("ClaudeStatusReporter", () => {
  it("reads a login at startup, waits for that read, and keeps the account, source and models", async () => {
    const readClaude = vi.fn<ReadClaude>(async () => read(firstParty, [opus, sonnet]));
    const { claude } = reporter(readClaude);
    expect(claude.status()).toBeNull();
    const status = await claude.current();
    expect(status).toEqual({
      status: "signed_in",
      source: "login",
      account: { email: "steve@example.com", organization: "Example", subscriptionType: "max" },
      models: [
        { value: "opus", displayName: "Opus" },
        { value: "sonnet", displayName: "Sonnet" },
      ],
      checkedAt: "2026-10-28T10:00:00.000Z",
    } satisfies ClaudeStatus);
    expect(claude.status()).toEqual(status);
    expect(readClaude).toHaveBeenCalledTimes(1);
    // The heartbeat's report leaves the account out.
    expect(ClaudeStatusReporter.report(status)).toEqual({
      status: "signed_in",
      source: "login",
      checkedAt: "2026-10-28T10:00:00.000Z",
    });
  });

  it.each<[string, AccountInfo, ClaudeStatus["source"]]>([
    [
      "an API key from ANTHROPIC_API_KEY",
      { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" },
      "api_key",
    ],
    [
      "an OAuth token from CLAUDE_CODE_OAUTH_TOKEN",
      { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" },
      "oauth_token",
    ],
    ["Bedrock", { apiProvider: "bedrock" }, "other"],
    ["Vertex", { apiProvider: "vertex" }, "other"],
    ["a login without a provider", { email: "steve@example.com" }, "login"],
  ])("signs in with %s", async (_, account, source) => {
    const { claude } = reporter(async () => read(account));
    expect(await claude.current()).toMatchObject({ status: "signed_in", source });
  });

  it("is signed out when the read fails with an authentication error", async () => {
    const logger = silentLogger();
    const warn = vi.spyOn(logger, "warn");
    const { claude } = reporter(async () => {
      throw new Error("Invalid API key · Please run /login");
    }, logger);
    expect(await claude.current()).toEqual({
      status: "signed_out",
      source: null,
      models: [],
      checkedAt: "2026-10-28T10:00:00.000Z",
      error: "Invalid API key · Please run /login",
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is signed out when the login reports no models", async () => {
    const { claude } = reporter(async () =>
      read(firstParty, [{ value: "", displayName: "Nothing", description: "" }]),
    );
    expect(await claude.current()).toMatchObject({
      status: "signed_out",
      source: null,
      models: [],
      error: expect.any(String),
    });
    expect(claude.status()).not.toHaveProperty("account");
  });

  it("is unknown when the read times out", async () => {
    const claude = new ClaudeStatusReporter({
      read: () => new Promise(() => {}),
      logger: silentLogger(),
      readTimeoutMs: 10,
    });
    expect(await claude.current()).toMatchObject({
      status: "unknown",
      source: null,
      models: [],
      error: "timed out checking Claude",
    });
  });

  it("is unknown when the read fails for another reason", async () => {
    const { claude } = reporter(async () => {
      throw new Error("spawn claude ENOENT");
    });
    expect(await claude.current()).toMatchObject({ status: "unknown", source: null });
  });

  it("reads again at most once an hour in the background, keeping the last state meanwhile", async () => {
    const readClaude = vi.fn<ReadClaude>(async () => read(firstParty, [opus]));
    const { claude, advance } = reporter(readClaude);
    await claude.current();
    advance(CLAUDE_STATUS_REFRESH_INTERVAL_MS - 1);
    await claude.current();
    expect(readClaude).toHaveBeenCalledTimes(1);

    let finish!: (value: ClaudeRead) => void;
    readClaude.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    advance(1);
    // The hourly read runs in the background: the heartbeat isn't held up.
    expect((await claude.current()).models).toEqual([{ value: "opus", displayName: "Opus" }]);
    expect((await claude.current()).models).toEqual([{ value: "opus", displayName: "Opus" }]);
    expect(readClaude).toHaveBeenCalledTimes(2);
    finish(read(firstParty, [sonnet]));
    await vi.waitFor(async () =>
      expect((await claude.current()).models).toEqual([{ value: "sonnet", displayName: "Sonnet" }]),
    );
    expect(readClaude).toHaveBeenCalledTimes(2);
  });

  it("logs a failing login once until a read succeeds", async () => {
    const logger = silentLogger();
    const warn = vi.spyOn(logger, "warn");
    const readClaude = vi.fn<ReadClaude>(async () => {
      throw new Error("not logged in");
    });
    const { claude, advance } = reporter(readClaude, logger);
    await claude.current();
    advance(CLAUDE_STATUS_REFRESH_INTERVAL_MS);
    await claude.check();
    expect(readClaude).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);

    readClaude.mockResolvedValueOnce(read(firstParty));
    advance(CLAUDE_STATUS_REFRESH_INTERVAL_MS);
    expect((await claude.check()).status).toBe("signed_in");
    readClaude.mockRejectedValueOnce(new Error("Not logged in · Please run /login"));
    advance(CLAUDE_STATUS_REFRESH_INTERVAL_MS);
    expect((await claude.check()).status).toBe("signed_out");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("checks again at once, at most once per 10 s, and concurrent checks share one read", async () => {
    const readClaude = vi.fn<ReadClaude>(async () => read(firstParty));
    const { claude, advance } = reporter(readClaude);
    await claude.current();
    expect(readClaude).toHaveBeenCalledTimes(1);

    // Too soon after the startup read: the last state answers.
    advance(CLAUDE_STATUS_CHECK_MIN_INTERVAL_MS - 1);
    expect((await claude.check()).checkedAt).toBe("2026-10-28T10:00:00.000Z");
    expect(readClaude).toHaveBeenCalledTimes(1);

    let finish!: (value: ClaudeRead) => void;
    readClaude.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    advance(1);
    const first = claude.check();
    const second = claude.check();
    // A heartbeat meanwhile doesn't start another read either.
    await claude.current();
    expect(readClaude).toHaveBeenCalledTimes(2);
    finish(read({ apiKeySource: "ANTHROPIC_API_KEY" }));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a).toMatchObject({
      source: "api_key",
      checkedAt: new Date(START + CLAUDE_STATUS_CHECK_MIN_INTERVAL_MS).toISOString(),
    });

    advance(CLAUDE_STATUS_CHECK_MIN_INTERVAL_MS);
    await claude.check();
    expect(readClaude).toHaveBeenCalledTimes(3);
    // A check doesn't move the hourly refresh earlier than an hour after it.
    advance(CLAUDE_STATUS_REFRESH_INTERVAL_MS - 1);
    await claude.current();
    expect(readClaude).toHaveBeenCalledTimes(3);
  });

  it("emits each check's result", async () => {
    const { claude } = reporter(async () => read(firstParty));
    const changes: ClaudeStatus[] = [];
    claude.on("change", (status) => changes.push(status));
    const status = await claude.current();
    expect(changes).toEqual([status]);
  });

  it("drops models without a value and falls back to the value as display name", async () => {
    const { claude } = reporter(async () =>
      read(firstParty, [
        { value: "", displayName: "Nothing", description: "" },
        { value: "haiku", displayName: "", description: "" },
      ]),
    );
    expect((await claude.current()).models).toEqual([{ value: "haiku", displayName: "haiku" }]);
  });
});

describe("sdkReadClaude", () => {
  it("asks an idle session without tools or settings for its models and account, then closes it", async () => {
    const close = vi.fn();
    const calls: Parameters<ClaudeQueryFn>[0][] = [];
    const query: ClaudeQueryFn = (params) => {
      calls.push(params);
      return {
        supportedModels: async () => [opus],
        accountInfo: async () => firstParty,
        close,
      };
    };
    const readClaude = sdkReadClaude(query, { HOME: "/home/agent" });
    expect(await readClaude(new AbortController().signal)).toEqual({
      models: [opus],
      account: firstParty,
    });
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
    const query: ClaudeQueryFn = ({ options }) => {
      aborted = options.abortController.signal;
      return {
        supportedModels: () =>
          new Promise((_, reject) =>
            aborted!.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
        accountInfo: async () => firstParty,
        close,
      };
    };
    const controller = new AbortController();
    const reading = sdkReadClaude(query, {})(controller.signal);
    controller.abort();
    await expect(reading).rejects.toThrow("aborted");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
