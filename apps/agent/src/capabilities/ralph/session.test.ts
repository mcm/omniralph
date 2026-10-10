import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { RALPH_TOOL_POLICY } from "./policy.js";
import {
  createSessionRunner,
  type MessageInjector,
  type SessionQueryFn,
  PERMISSION_DENIED_TEXT,
  type SessionRequest,
  WAIT_NUDGE_TEXT,
} from "./session.js";

type Behaviour = "separate-turns" | "folded" | "silent-after-result";

const text = (m: SDKUserMessage) => m.message.content as string;

/**
 * A fake SDK `query()` (ported from cyralph's runner tests): answers each
 * streamed user message with a result frame naming the messages it answered.
 */
function fakeQuery(behaviour: Behaviour): { query: SessionQueryFn; sent: SDKUserMessage[] } {
  const sent: SDKUserMessage[] = [];
  const query: SessionQueryFn = ({ prompt }) =>
    (async function* () {
      const it = prompt[Symbol.asyncIterator]();
      const first = await it.next();
      if (first.done) return;
      sent.push(first.value);
      let pending: SDKUserMessage[] = [first.value];
      while (pending.length) {
        const batch = pending;
        pending = [];
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            content: [{ type: "text", text: `working on ${batch.map(text).join(" + ")}` }],
          },
        };
        // Give the test a chance to inject while the turn is in flight.
        await new Promise((r) => setTimeout(r, 20));
        if (behaviour === "folded") {
          // Messages sent mid-turn are folded into this turn's result.
          const extra = await Promise.race([
            it.next(),
            new Promise<null>((r) => setTimeout(() => r(null), 5)),
          ]);
          if (extra && !extra.done) {
            sent.push(extra.value);
            batch.push(extra.value);
          }
        }
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: `answered ${batch.map(text).join(" + ")}`,
          structured_output: { answered: batch.map(text) },
          user_message_uuids: batch.map((m) => m.uuid),
          modelUsage: {
            opus: {
              inputTokens: 10,
              outputTokens: 2,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
        };
        // A session that never answers what was injected after its result.
        if (behaviour === "silent-after-result") {
          for (;;) {
            const next = await it.next();
            if (next.done) return;
            sent.push(next.value);
          }
        }
        const next = await it.next();
        if (!next.done) {
          sent.push(next.value);
          pending.push(next.value);
        }
      }
    })() as AsyncGenerator<SDKMessage>;
  return { query, sent };
}

function start(behaviour: Behaviour, extra: Partial<SessionRequest> = {}) {
  const fake = fakeQuery(behaviour);
  let inject: MessageInjector | undefined;
  const done = createSessionRunner(fake.query)({
    prompt: "story",
    cwd: process.cwd(),
    policy: RALPH_TOOL_POLICY,
    systemAppend: "",
    outputSchema: { type: "object" },
    env: {},
    signal: new AbortController().signal,
    onInjector: (fn) => {
      inject = fn;
    },
    ...extra,
  });
  return {
    done,
    sent: fake.sent,
    inject: (t: string) => inject?.(t) ?? false,
    hasInjector: () => inject !== undefined,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("session runner streaming input", () => {
  it("keeps the session open until an injected message is answered", async () => {
    const r = start("separate-turns");
    await wait(5);
    expect(r.inject("follow-up")).toBe(true);
    const result = await r.done;
    expect(result).toMatchObject({ stop: "completed", output: "answered follow-up" });
    expect(r.sent.map((m) => [text(m), m.priority])).toEqual([
      ["story", undefined],
      ["follow-up", "next"],
    ]);
    expect(r.hasInjector()).toBe(false);
    expect(r.inject("too late")).toBe(false);
  });

  it("does not hang when the injected message is folded into the running turn", async () => {
    const r = start("folded");
    await wait(5);
    r.inject("folded");
    const result = await r.done;
    expect(result.output).toBe("answered story + folded");
  });

  it("finishes after one turn when nothing is injected", async () => {
    const r = start("separate-turns");
    const result = await r.done;
    expect(result).toMatchObject({ stop: "completed", output: "answered story" });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(r.hasInjector()).toBe(false);
  });

  it("returns the last turn's structured result, also with injected messages", async () => {
    const r = start("separate-turns");
    await wait(5);
    r.inject("guidance");
    const result = await r.done;
    expect(result).toMatchObject({ stop: "completed", structured: { answered: ["guidance"] } });
  });

  it("stops waiting for an unanswered injected message after the idle timeout", async () => {
    const r = start("silent-after-result", { injectionIdleTimeoutMs: 50 });
    await wait(5);
    r.inject("never answered");
    const result = await r.done;
    // The earlier turn's result counts.
    expect(result).toMatchObject({ stop: "completed", output: "answered story" });
    expect(r.hasInjector()).toBe(false);
  });
});

/** What a scripted fake session can do: read the runner's input, and see what it sent. */
interface Script {
  next: () => Promise<SDKUserMessage | undefined>;
  sent: SDKUserMessage[];
  /** The SDK options the session was started with. */
  options: Options;
}

/** A fake SDK `query()` that yields what `script` yields, so a test controls every message. */
function scriptedQuery(script: (io: Script) => AsyncGenerator<unknown>): {
  query: SessionQueryFn;
  sent: SDKUserMessage[];
} {
  const sent: SDKUserMessage[] = [];
  const query: SessionQueryFn = ({ prompt, options }) =>
    (async function* () {
      const it = prompt[Symbol.asyncIterator]();
      const next = async () => {
        const r = await it.next();
        if (r.done) return undefined;
        sent.push(r.value);
        return r.value;
      };
      const signal = options?.abortController?.signal;
      const gen = script({ next, sent, options: options ?? {} });
      for (;;) {
        // Like the SDK, an aborted session stops yielding.
        const step = await Promise.race([
          gen.next(),
          new Promise<"aborted">((r) => {
            if (signal?.aborted) r("aborted");
            signal?.addEventListener("abort", () => r("aborted"), { once: true });
          }),
        ]);
        if (step === "aborted") throw new Error("aborted");
        if (step.done) return;
        yield step.value as SDKMessage;
      }
    })();
  return { query, sent };
}

const turn = () => ({ type: "system", subtype: "init" });
const say = (t: string, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content: [{ type: "text", text: t }] },
});
const tasks = (...live: { id: string; ambient?: boolean }[]) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: live.map((t) => ({
    task_id: t.id,
    task_type: "local_agent",
    description: t.id,
    ...(t.ambient && { ambient: true }),
  })),
});
const result = (status: string, answers?: SDKUserMessage[]) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: status,
  structured_output: { status },
  ...(answers && { user_message_uuids: answers.map((m) => m.uuid) }),
  modelUsage: {},
});
const isWaiting = (s: unknown) => (s as { status?: string }).status === "waiting";

function run(script: (io: Script) => AsyncGenerator<unknown>, extra: Partial<SessionRequest> = {}) {
  const fake = scriptedQuery(script);
  const done = createSessionRunner(fake.query)({
    prompt: "story",
    cwd: process.cwd(),
    policy: RALPH_TOOL_POLICY,
    systemAppend: "",
    outputSchema: { type: "object" },
    env: {},
    signal: new AbortController().signal,
    isWaiting,
    idleTimeoutMs: 30,
    ...extra,
  });
  return { done, sent: fake.sent };
}

describe("session runner permission prompts", () => {
  const ask = { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" };

  it("asks about a call the repository's settings ask about, without timing out meanwhile", async () => {
    const calls: unknown[] = [];
    let decision: unknown;
    const r = run(
      async function* ({ next, options }) {
        await next();
        yield turn();
        // A person takes longer to answer than the idle timeout.
        decision = await options.canUseTool!("Bash", { command: "git commit" }, ask);
        yield result("complete");
      },
      {
        askPermission: async (call) => {
          calls.push(call);
          await wait(80);
          return true;
        },
      },
    );
    expect(await r.done).toMatchObject({ stop: "completed" });
    expect(decision).toMatchObject({ behavior: "allow", updatedInput: { command: "git commit" } });
    expect(calls).toEqual([{ tool: "Bash", input: { command: "git commit" } }]);
  });

  it("denies the call when the person says no, and without an asker sets no canUseTool", async () => {
    let decision: unknown;
    let canUseTool: unknown = "unset";
    const denied = run(
      async function* ({ next, options }) {
        await next();
        decision = await options.canUseTool!("Bash", { command: "git push" }, ask);
        yield result("complete");
      },
      { askPermission: async () => false },
    );
    await denied.done;
    expect(decision).toMatchObject({ behavior: "deny", message: PERMISSION_DENIED_TEXT });

    const none = run(async function* ({ next, options }) {
      await next();
      canUseTool = options.canUseTool;
      yield result("complete");
    });
    await none.done;
    expect(canUseTool).toBeUndefined();
  });
});

describe("session runner background work", () => {
  it("keeps a waiting session open, silent past the idle timeout, until its next turn", async () => {
    const r = run(async function* ({ next }) {
      const prompt = (await next())!;
      yield turn();
      yield tasks({ id: "a1" });
      yield result("waiting", [prompt]);
      // Background work: no messages for longer than the idle timeout.
      await wait(80);
      yield tasks();
      // Claude Code starts a turn for the task notification; it answers none of our messages.
      yield turn();
      yield say("the assessments are in");
      yield result("complete");
    });
    const result_ = await r.done;
    expect(result_).toMatchObject({ stop: "completed", structured: { status: "complete" } });
    expect(result_.error).toBeUndefined();
    expect(r.sent).toHaveLength(1);
  });

  it("doesn't count a background subagent's messages as the session's turn", async () => {
    const r = run(async function* ({ next }) {
      const prompt = (await next())!;
      yield tasks({ id: "a1" });
      yield result("waiting", [prompt]);
      yield say("subagent working", "toolu_1");
      await wait(80);
      yield tasks();
      yield turn();
      yield result("complete");
    });
    expect(await r.done).toMatchObject({ stop: "completed", structured: { status: "complete" } });
  });

  it("returns the waiting result when the background work outlasts the wait timeout", async () => {
    const r = run(
      async function* ({ next }) {
        const prompt = (await next())!;
        yield tasks({ id: "a1" });
        yield result("waiting", [prompt]);
        await wait(10_000);
      },
      { backgroundWaitTimeoutMs: 50 },
    );
    const result_ = await r.done;
    expect(result_).toMatchObject({ stop: "completed", structured: { status: "waiting" } });
    expect(result_.error).toMatch(/background work took longer than/);
  });

  it("nudges a session that waits with nothing running", async () => {
    const r = run(
      async function* ({ next }) {
        const prompt = (await next())!;
        // Only an ambient task (e.g. a watcher) runs: that's nothing to wait for.
        yield tasks({ id: "watch", ambient: true });
        yield result("waiting", [prompt]);
        const nudge = (await next())!;
        yield turn();
        yield result("complete", [nudge]);
      },
      { waitNudgeDelayMs: 20 },
    );
    expect(await r.done).toMatchObject({ stop: "completed", structured: { status: "complete" } });
    expect(r.sent.map((m) => [text(m), m.priority])).toEqual([
      ["story", undefined],
      [WAIT_NUDGE_TEXT, "next"],
    ]);
  });

  it("gives up on a session that keeps waiting with nothing running", async () => {
    const r = run(
      async function* ({ next }) {
        const prompt = (await next())!;
        yield result("waiting", [prompt]);
        const nudge = (await next())!;
        yield turn();
        yield result("waiting", [nudge]);
        await wait(10_000);
      },
      { waitNudgeDelayMs: 20 },
    );
    const result_ = await r.done;
    expect(result_).toMatchObject({ stop: "completed", structured: { status: "waiting" } });
    expect(result_.error).toMatch(/kept waiting with nothing running/);
    expect(r.sent).toHaveLength(2);
  });

  it("gives up when no turn takes the nudge", async () => {
    const r = run(
      async function* ({ next }) {
        const prompt = (await next())!;
        yield result("waiting", [prompt]);
        await next(); // the nudge, which never gets a turn
        await wait(10_000);
      },
      { waitNudgeDelayMs: 20 },
    );
    const result_ = await r.done;
    expect(result_).toMatchObject({ stop: "completed", structured: { status: "waiting" } });
    expect(result_.error).toMatch(/kept waiting with nothing running/);
    expect(r.sent.map(text)).toEqual(["story", WAIT_NUDGE_TEXT]);
  });

  it("ends the session on a result that doesn't wait, even while background work runs", async () => {
    const r = run(async function* ({ next }) {
      const prompt = (await next())!;
      yield tasks({ id: "dev-server" });
      yield result("complete", [prompt]);
      await wait(10_000);
    });
    expect(await r.done).toMatchObject({ stop: "completed", structured: { status: "complete" } });
  });

  it("still times out a turn that goes silent while background work runs", async () => {
    const r = run(async function* ({ next }) {
      await next();
      yield tasks({ id: "a1" });
      yield say("thinking");
      await wait(10_000);
    });
    expect(await r.done).toMatchObject({ stop: "idle" });
  });

  it("answers an injected message while it waits", async () => {
    let inject: MessageInjector | undefined;
    const r = run(
      async function* ({ next }) {
        const prompt = (await next())!;
        yield tasks({ id: "a1" });
        yield result("waiting", [prompt]);
        const reply = (await next())!;
        yield turn();
        yield result("waiting", [reply]);
        await wait(80);
        yield tasks();
        yield turn();
        yield result("complete");
      },
      { onInjector: (fn) => (inject = fn) },
    );
    await wait(5);
    expect(inject?.("how is it going?")).toBe(true);
    expect(await r.done).toMatchObject({ stop: "completed", structured: { status: "complete" } });
    expect(r.sent.map(text)).toEqual(["story", "how is it going?"]);
  });
});
