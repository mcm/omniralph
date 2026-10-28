// @vitest-environment jsdom
import { LIVE_NOTICE_MESSAGE } from "@omniralph/ui";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptDetail } from "../../../src/attempts/history.js";
import type { LogEntry } from "../../../src/logs/entries.js";
import { isFallbackPolling } from "../query-client.js";
import { agentState, fakeApi, fakeEventSources, renderAgentPage } from "../test/page.js";
import { agentKeys } from "./keys.js";
import { FALLBACK_POLL_INTERVAL } from "../query-client.js";
import { LIVE_NOTICE_DELAY_MS, LIVE_RECONNECT_MS } from "./live-provider.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Lets fetches and renders settle, advancing the clock by `ms`. */
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function setup() {
  const api = fakeApi({ "/api/state": { body: agentState() } });
  const streams = fakeEventSources();
  const view = renderAgentPage({ createEventSource: streams.create });
  await advance();
  return { api, streams, stream: streams.latest(), ...view };
}

const STATE = "GET /api/state";

describe("the live stream", () => {
  it("opens /api/events", async () => {
    const { streams } = await setup();
    expect(streams.sources.map((source) => source.url)).toEqual(["/api/events"]);
  });

  it("refetches the queries a change event maps to", async () => {
    const { api, stream } = await setup();
    stream.open();
    expect(api.count(STATE)).toBe(1);
    stream.change({ resource: "settings" });
    await advance();
    expect(api.count(STATE)).toBe(2);
    stream.change({ resource: "claude" });
    await advance();
    expect(api.count(STATE)).toBe(3);
    // Packages aren't on this page: nothing to refetch.
    stream.change({ resource: "packages" });
    await advance();
    expect(api.calls.filter((call) => call !== STATE)).toEqual([]);
  });

  it("invalidates only the attempts an event names", async () => {
    const { stream, queryClient } = await setup();
    stream.open();
    queryClient.setQueryData(agentKeys.attempts.detail("job-1"), { id: "job-1" });
    queryClient.setQueryData(agentKeys.attempts.detail("job-2"), { id: "job-2" });
    stream.change({ resource: "attempts", ids: ["job-1"] });
    await advance();
    expect(queryClient.getQueryState(agentKeys.attempts.detail("job-1"))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(agentKeys.attempts.detail("job-2"))?.isInvalidated).toBe(
      false,
    );
  });

  it("appends log lines to the cache without a request", async () => {
    const { api, stream, queryClient } = await setup();
    stream.open();
    const line = (msg: string): LogEntry => ({ time: 1, level: "info", msg, fields: {} });
    stream.change({ resource: "logs", data: [line("agent started")] });
    stream.change({ resource: "logs", data: [line("claimed a job"), line("heartbeat")] });
    await advance();
    expect(
      queryClient.getQueryData<LogEntry[]>(agentKeys.logs.tail)?.map((entry) => entry.msg),
    ).toEqual(["agent started", "claimed a job", "heartbeat"]);
    expect(api.calls).toEqual([STATE]);
  });

  it("appends transcript events to their attempt without a request", async () => {
    const { api, stream, queryClient } = await setup();
    stream.open();
    const event = (body: string) => ({
      type: "thought",
      body,
      parameter: null,
      at: "2026-10-28T10:00:00Z",
    });
    queryClient.setQueryData(agentKeys.attempts.detail("job-1"), {
      id: "job-1",
      events: [event("Reading the story")],
    });
    stream.change({ resource: "transcript", ids: ["job-1"], data: [event("Running the tests")] });
    stream.change({ resource: "transcript", ids: ["job-2"], data: [event("Elsewhere")] });
    await advance();
    const detail = queryClient.getQueryData<AttemptDetail>(agentKeys.attempts.detail("job-1"));
    expect(detail?.events.map((entry) => entry.body)).toEqual([
      "Reading the story",
      "Running the tests",
    ]);
    expect(queryClient.getQueryData(agentKeys.attempts.detail("job-2"))).toBeUndefined();
    expect(api.calls).toEqual([STATE]);
  });

  it("ignores events it can't read", async () => {
    const { api, stream } = await setup();
    stream.open();
    stream.change({ resource: "nonsense" as "status" });
    await advance();
    expect(api.count(STATE)).toBe(1);
  });
});

describe("polling", () => {
  it("doesn't poll while the stream is up", async () => {
    const { api, stream, queryClient } = await setup();
    stream.open();
    await advance(FALLBACK_POLL_INTERVAL * 3);
    expect(api.count(STATE)).toBe(1);
    expect(isFallbackPolling(queryClient)).toBe(false);
  });

  it("polls every 10 s only while the stream is down, and catches up once on reconnect", async () => {
    const { api, stream, queryClient } = await setup();
    stream.open();
    stream.fail();
    expect(isFallbackPolling(queryClient)).toBe(true);
    await advance(FALLBACK_POLL_INTERVAL - 1);
    expect(api.count(STATE)).toBe(1);
    await advance(1);
    expect(api.count(STATE)).toBe(2);
    await advance(FALLBACK_POLL_INTERVAL);
    expect(api.count(STATE)).toBe(3);

    stream.open();
    await advance();
    expect(api.count(STATE)).toBe(4);
    expect(isFallbackPolling(queryClient)).toBe(false);
    await advance(FALLBACK_POLL_INTERVAL * 3);
    expect(api.count(STATE)).toBe(4);
  });

  it("doesn't catch up on the first connection", async () => {
    const { api, stream } = await setup();
    stream.open();
    await advance();
    expect(api.count(STATE)).toBe(1);
  });

  it("opens a new stream when the browser gives up on one", async () => {
    const { streams, stream } = await setup();
    stream.fail({ closed: true });
    await advance(LIVE_RECONNECT_MS - 1);
    expect(streams.sources).toHaveLength(1);
    await advance(1);
    expect(streams.sources).toHaveLength(2);
    expect(stream.closed).toBe(true);
    streams.latest().open();
    expect(screen.queryByText(LIVE_NOTICE_MESSAGE)).toBeNull();
  });
});

describe("LiveNotice", () => {
  it("shows after 5 s down and goes on reconnect", async () => {
    const { stream } = await setup();
    stream.open();
    stream.fail();
    await advance(LIVE_NOTICE_DELAY_MS - 1);
    expect(screen.queryByText(LIVE_NOTICE_MESSAGE)).toBeNull();
    await advance(1);
    expect(screen.getByText(LIVE_NOTICE_MESSAGE)).toBeTruthy();
    stream.open();
    await advance();
    expect(screen.queryByText(LIVE_NOTICE_MESSAGE)).toBeNull();
  });

  it("never shows while connecting or connected", async () => {
    const { stream } = await setup();
    await advance(LIVE_NOTICE_DELAY_MS * 2);
    expect(screen.queryByText(LIVE_NOTICE_MESSAGE)).toBeNull();
    stream.open();
    await advance(LIVE_NOTICE_DELAY_MS * 2);
    expect(screen.queryByText(LIVE_NOTICE_MESSAGE)).toBeNull();
  });

  it("Retry now opens a new stream and refetches", async () => {
    const { api, streams, stream } = await setup();
    stream.fail();
    await advance(LIVE_NOTICE_DELAY_MS);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await advance();
    expect(streams.sources).toHaveLength(2);
    expect(stream.closed).toBe(true);
    expect(api.count(STATE)).toBe(2);
  });
});
