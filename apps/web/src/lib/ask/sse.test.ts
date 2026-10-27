import { describe, expect, it } from "vitest";
import { ASK_STREAM_EVENT_NAMES, formatSseEvent, parseSseChunks, type AskStreamEvent } from "./sse";

const EVENTS: AskStreamEvent[] = [
  { event: "chat", data: { chat: { id: "c1", title: "Why does last() fail?" } } },
  {
    event: "message",
    data: { message: { id: "m1", author: "user", markdown: 'line 1\nline 2 "quoted"' } },
  },
  { event: "delta", data: { messageId: "m2", text: "`last()` reads one past\n\nthe end." } },
  { event: "status", data: { text: "Asking an agent to read customer-portal" } },
  { event: "error", data: { message: "Sorry, something went wrong." } },
  { event: "done", data: {} },
];

const wire = (events: AskStreamEvent[]) =>
  events.map((e) => formatSseEvent(e.event, e.data as never)).join("");

describe("formatSseEvent", () => {
  it("writes the event name and one JSON data line", () => {
    expect(formatSseEvent("status", { text: "Looking at runs" })).toBe(
      'event: status\ndata: {"text":"Looking at runs"}\n\n',
    );
    expect(formatSseEvent("delta", { messageId: "m", text: "a\nb" })).toBe(
      'event: delta\ndata: {"messageId":"m","text":"a\\nb"}\n\n',
    );
  });
});

describe("parseSseChunks", () => {
  it("round-trips every event type", () => {
    expect(EVENTS.map((e) => e.event).sort()).toEqual([...ASK_STREAM_EVENT_NAMES].sort());
    expect(parseSseChunks(wire(EVENTS))).toEqual({ events: EVENTS, rest: "" });
  });

  it("reads two events in one chunk", () => {
    const { events, rest } = parseSseChunks(wire(EVENTS.slice(2, 4)));
    expect(events).toEqual(EVENTS.slice(2, 4));
    expect(rest).toBe("");
  });

  it("keeps a JSON payload split across two chunks until it is complete", () => {
    const text = wire([EVENTS[1]!, EVENTS[2]!]);
    // Cut in the middle of the second event's JSON.
    const cut = text.indexOf('"text":') + 4;
    const first = parseSseChunks(text.slice(0, cut));
    expect(first.events).toEqual([EVENTS[1]]);
    expect(first.rest).toBe(text.slice(text.indexOf("event: delta"), cut));
    const second = parseSseChunks(first.rest + text.slice(cut));
    expect(second).toEqual({ events: [EVENTS[2]], rest: "" });
  });

  it("splits at every byte and still reads every event once", () => {
    const text = wire(EVENTS);
    const events: AskStreamEvent[] = [];
    let buffer = "";
    for (const char of text) {
      const parsed = parseSseChunks(buffer + char);
      events.push(...parsed.events);
      buffer = parsed.rest;
    }
    expect(events).toEqual(EVENTS);
    expect(buffer).toBe("");
  });

  it("reads CRLF line endings and skips comments, unknown events and broken JSON", () => {
    const text =
      ': keep-alive\r\n\r\nevent: status\r\ndata: {"text":"Looking at runs"}\r\n\r\n' +
      "event: nope\ndata: {}\n\nevent: delta\ndata: {not json\n\n";
    expect(parseSseChunks(text)).toEqual({
      events: [{ event: "status", data: { text: "Looking at runs" } }],
      rest: "",
    });
  });
});
