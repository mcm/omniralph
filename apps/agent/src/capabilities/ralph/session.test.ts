import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { RALPH_TOOL_POLICY } from "./policy.js";
import {
  createSessionRunner,
  type MessageInjector,
  type SessionQueryFn,
  type SessionRequest,
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
