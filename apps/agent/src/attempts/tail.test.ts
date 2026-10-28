import { describe, expect, it, vi } from "vitest";
import { sessionTee, type SessionEvent, type SessionResult } from "../session/session.js";
import { assistantMessage, sessionRequest } from "../test/fake-query.js";
import { JOB_TAIL_SIZE, JobTail, type TailEvent } from "./tail.js";

const AT = "2026-10-28T10:00:00.000Z";
const now = () => new Date(AT);

describe("JobTail", () => {
  it("keeps session events as transcript rows, through activityFor", () => {
    const tail = new JobTail({ now });
    tail.event({ type: "text", text: "  Reading the PRD.  " });
    tail.event({ type: "tool", name: "Bash", input: { command: "pnpm test" } });
    // Not shown: blank text and TodoWrite.
    tail.event({ type: "text", text: "   " });
    tail.event({ type: "tool", name: "TodoWrite", input: { todos: [] } });
    tail.event({ type: "tool", name: "Read", input: {} });

    expect(tail.events()).toEqual([
      { type: "thought", body: "Reading the PRD.", parameter: null, at: AT },
      { type: "action", body: "Bash", parameter: "pnpm test", at: AT },
      { type: "action", body: "Read", parameter: "", at: AT },
    ]);
  });

  it(`keeps the last ${JOB_TAIL_SIZE} events by default`, () => {
    const tail = new JobTail({ now });
    for (let i = 0; i < JOB_TAIL_SIZE + 5; i++) tail.event({ type: "text", text: `line ${i}` });

    const events = tail.events();
    expect(events).toHaveLength(JOB_TAIL_SIZE);
    expect(events[0]!.body).toBe("line 5");
    expect(events.at(-1)!.body).toBe(`line ${JOB_TAIL_SIZE + 4}`);
  });

  it("notifies subscribers until they unsubscribe or the tail closes", () => {
    const tail = new JobTail({ now, size: 3 });
    const seen: TailEvent[] = [];
    const failing = vi.fn(() => {
      throw new Error("broken subscriber");
    });
    const unsubscribe = tail.subscribe((event) => seen.push(event));
    tail.subscribe(failing);

    tail.event({ type: "text", text: "one" });
    unsubscribe();
    tail.event({ type: "text", text: "two" });
    tail.close();
    tail.event({ type: "text", text: "three" });

    expect(seen.map((e) => e.body)).toEqual(["one"]);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(tail.events().map((e) => e.body)).toEqual(["one", "two", "three"]);
  });
});

describe("sessionTee", () => {
  const done: SessionResult = {
    stop: "completed",
    output: "",
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  it("passes a runner's events to the request's onEvent first, then the observer", async () => {
    const order: string[] = [];
    const tee = sessionTee((event) => {
      order.push(`tail:${event.type}`);
      throw new Error("observers never break a session");
    });
    const runner = tee.runner(async (request) => {
      request.onEvent?.({ type: "text", text: "hi" });
      request.onEvent?.({ type: "tool", name: "Read", input: {} });
      return done;
    });
    const relayed: SessionEvent[] = [];

    const result = await runner(
      sessionRequest({
        onEvent: (event) => {
          relayed.push(event);
          order.push(`relay:${event.type}`);
        },
      }),
    );

    expect(result).toBe(done);
    expect(relayed).toEqual([
      { type: "text", text: "hi" },
      { type: "tool", name: "Read", input: {} },
    ]);
    expect(order).toEqual(["relay:text", "tail:text", "relay:tool", "tail:tool"]);
  });

  it("observes an SDK query's top-level messages and yields them unchanged", async () => {
    const observed: SessionEvent[] = [];
    const top = assistantMessage("Top", { toolUse: true });
    const sub = { ...assistantMessage("Subagent"), parent_tool_use_id: "t0" } as typeof top;
    const query = sessionTee((event) => observed.push(event)).query((_params: { prompt: string }) =>
      (async function* () {
        yield top;
        yield sub;
      })(),
    );

    const messages = [];
    for await (const message of query({ prompt: "p" })) messages.push(message);

    expect(messages).toEqual([top, sub]);
    expect(observed).toEqual([
      { type: "text", text: "Top" },
      { type: "tool", name: "Read", input: {} },
    ]);
  });
});
