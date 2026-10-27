import { describe, expect, it, vi } from "vitest";
import { parseSseChunks, type AskStreamEvent } from "@/lib/ask/sse";

vi.mock("server-only", () => ({}));

const { sendWebEvent, webEventStream, withWebStream, WEB_STREAM_ERROR } =
  await import("./web-stream");

/** Every event of a stream, read to its end. */
async function readAll(body: ReadableStream<Uint8Array>): Promise<AskStreamEvent[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: AskStreamEvent[] = [];
  let buffer = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    const parsed = parseSseChunks(buffer + decoder.decode(r.value, { stream: true }));
    events.push(...parsed.events);
    buffer = parsed.rest;
  }
  return events;
}

describe("withWebStream", () => {
  it("sends events to the scope's writer, and drops them outside it", async () => {
    const sent: unknown[] = [];
    sendWebEvent("status", { text: "dropped" });
    await withWebStream({ send: (name, data) => void sent.push([name, data]) }, async () => {
      await Promise.resolve();
      sendWebEvent("status", { text: "Looking at runs" });
    });
    expect(sent).toEqual([["status", { text: "Looking at runs" }]]);
  });

  it("never throws when the writer does", () => {
    expect(() =>
      withWebStream(
        {
          send: () => {
            throw new Error("closed");
          },
        },
        () => sendWebEvent("done", {}),
      ),
    ).not.toThrow();
  });
});

describe("webEventStream", () => {
  it("writes what the work sends as server-sent events, then done", async () => {
    const { body, finished } = webEventStream(async () => {
      sendWebEvent("message", { message: { id: "m1" } });
      await new Promise((resolve) => setTimeout(resolve, 5));
      sendWebEvent("delta", { messageId: "m1", text: "Hi" });
    });
    expect(await readAll(body)).toEqual([
      { event: "message", data: { message: { id: "m1" } } },
      { event: "delta", data: { messageId: "m1", text: "Hi" } },
      { event: "done", data: {} },
    ]);
    await finished;
  });

  it("ends a failed work with an error event and done", async () => {
    const onError = vi.fn();
    const failure = new Error("boom");
    const { body } = webEventStream(
      async () => {
        throw failure;
      },
      { onError },
    );
    expect(await readAll(body)).toEqual([
      { event: "error", data: { message: WEB_STREAM_ERROR } },
      { event: "done", data: {} },
    ]);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("goes on to the end when the client disconnects, dropping what it writes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const done = vi.fn();
    const { body, finished } = webEventStream(async () => {
      sendWebEvent("status", { text: "Thinking" });
      await gate;
      sendWebEvent("delta", { messageId: "m1", text: "after the disconnect" });
      done();
    });
    const reader = body.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    release();
    await finished;
    expect(done).toHaveBeenCalled();
  });

  it("prepares events in the order they were sent, and writes a failed one as sent", async () => {
    const onError = vi.fn();
    const { body } = webEventStream(
      async () => {
        sendWebEvent("message", { message: { id: "slow" } });
        sendWebEvent("delta", { messageId: "slow", text: "Hi" });
        sendWebEvent("message", { message: { id: "broken" } });
      },
      {
        onError,
        prepare: async (name, data) => {
          if (name !== "message") return data;
          const { id } = (data as { message: { id: string } }).message;
          if (id === "broken") throw new Error("lookup failed");
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { message: { id, full: true } } as typeof data;
        },
      },
    );
    expect(await readAll(body)).toEqual([
      { event: "message", data: { message: { id: "slow", full: true } } },
      { event: "delta", data: { messageId: "slow", text: "Hi" } },
      { event: "message", data: { message: { id: "broken" } } },
      { event: "done", data: {} },
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
