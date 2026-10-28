// @vitest-environment jsdom
import path from "node:path";
import { readFileSync } from "node:fs";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { LogEntry } from "../../../../src/logs/entries.js";
import { LOG_PAGE_LINES, type LogPageState } from "../../../../src/ui/log-routes.js";
import { LIVE_LOG_TAIL_SIZE } from "../../live/invalidations.js";
import {
  NARROW,
  WIDE,
  agentState,
  fakeApi,
  fakeEventSources,
  renderAgentPage,
} from "../../test/page.js";
import { clockTimeSeconds } from "../overview/model.js";
import {
  AT_LINE_LIMIT,
  LOG_PAGE_SIZE,
  MAX_LOG_LINES,
  NOTHING_LOGGED,
  NOTHING_MATCHES,
  entriesAfter,
  fitToCap,
  lineMatches,
  linesAfterPage,
} from "./model.js";

const START = Date.parse("2026-10-28T10:00:00.000Z");

function entry(n: number, overrides: Partial<LogEntry> = {}): LogEntry {
  return { time: START + n * 1_000, level: "info", msg: `line ${n}`, fields: {}, ...overrides };
}

/**
 * The agent's log file, oldest first, answered like `GET /api/logs` (newest first, paged
 * by `before`, filtered by `level` and `q`).
 */
function fakeLog(lines: LogEntry[]) {
  const requests: URLSearchParams[] = [];
  const route = (_init: RequestInit | undefined, url: URL) => {
    requests.push(url.searchParams);
    const level = url.searchParams.get("level") === "warn" ? "warn" : "all";
    const q = url.searchParams.get("q") ?? "";
    const matching = [...lines].reverse().filter((line) => lineMatches(line, { level, q }));
    const skip = Number(url.searchParams.get("before") ?? 0);
    const entries = matching.slice(skip, skip + LOG_PAGE_SIZE);
    const next = skip + entries.length;
    const body: LogPageState = {
      entries,
      before: next < matching.length ? String(next) : null,
    };
    return { body };
  };
  return { lines, requests, route };
}

async function openLogs({
  lines = [entry(1), entry(2)],
  width = WIDE,
}: { lines?: LogEntry[]; width?: number } = {}) {
  const log = fakeLog(lines);
  const api = fakeApi({ "/api/state": { body: agentState() }, "/api/logs": log.route });
  const streams = fakeEventSources();
  renderAgentPage({ path: "/logs", width, createEventSource: streams.create });
  await screen.findByRole("heading", { level: 2, name: "Logs", hidden: true });
  const list = await screen.findByRole("list", { name: "Log" });
  if (lines.length > 0) await within(list).findAllByRole("listitem");
  streams.latest().open();
  return { api, log, streams, list };
}

function shownMessages(list: HTMLElement): string[] {
  return [...list.querySelectorAll(".agent-logs__msg")].map((el) => el.textContent ?? "");
}

function sendLines(streams: ReturnType<typeof fakeEventSources>, lines: LogEntry[]) {
  streams.latest().change({ resource: "logs", data: lines });
}

/** Gives the line area a layout: `scrollHeight` 1000, 200 tall. */
function layOut(list: HTMLElement): HTMLElement {
  const area = list.closest<HTMLElement>(".agent-logs__lines")!;
  Object.defineProperty(area, "scrollHeight", { configurable: true, value: 1_000 });
  Object.defineProperty(area, "clientHeight", { configurable: true, value: 200 });
  return area;
}

describe("Logs", () => {
  it("shows the toolbar with its tooltips", async () => {
    await openLogs();
    const controls = screen.getByRole("group", { name: "Log controls" });
    const levels = within(controls).getByRole("radiogroup", { name: "Levels" });
    expect(within(levels).getByRole("radio", { name: "All" })).toHaveProperty(
      "ariaChecked",
      "true",
    );
    expect(within(levels).getByRole("radio", { name: "Warnings and errors" })).toBeDefined();
    expect(within(controls).getByRole("searchbox", { name: "Filter" })).toBeDefined();

    const user = userEvent.setup();
    await user.hover(within(controls).getByRole("button", { name: "Pause" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Pause");
    await user.unhover(within(controls).getByRole("button", { name: "Pause" }));

    const download = within(controls).getByRole("link", { name: "Download log" });
    expect(download.getAttribute("href")).toBe("/api/logs/download");
    expect(download.getAttribute("download")).toBe("agent.log");
    await user.hover(download);
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe("Download log"));
  });

  it("shows mono lines, oldest first, with time, level and message", async () => {
    const lines = [
      entry(1, { msg: "claimed a job" }),
      entry(2, { level: "warn", msg: "fetch was slow" }),
      entry(3, { level: "error", msg: "fetch failed" }),
    ];
    const { list } = await openLogs({ lines });
    expect(list.closest(".or-mono")).not.toBeNull();
    const items = within(list).getAllByRole("listitem");
    expect(shownMessages(list)).toEqual(["claimed a job", "fetch was slow", "fetch failed"]);
    expect(items[0]!.querySelector("time")!.textContent).toBe(clockTimeSeconds(lines[0]!.time));
    expect(items[0]!.querySelector("time")!.getAttribute("datetime")).toBe(
      new Date(lines[0]!.time).toISOString(),
    );
    expect(items.map((item) => item.querySelector(".agent-logs__level")!.textContent)).toEqual([
      "info",
      "warn",
      "error",
    ]);
    // Warnings and errors are in the fail tone.
    expect(items.map((item) => item.classList.contains("agent-logs__line--fail"))).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("says when nothing is logged, or nothing matches", async () => {
    await openLogs({ lines: [] });
    expect(await screen.findByText(NOTHING_LOGGED)).toBeDefined();
    await userEvent.setup().type(screen.getByRole("searchbox", { name: "Filter" }), "zzz");
    expect(await screen.findByText(NOTHING_MATCHES)).toBeDefined();
  });

  it("filters by level and text", async () => {
    const lines = [
      entry(1, { msg: "claimed a job" }),
      entry(2, { level: "warn", msg: "fetch was slow", fields: { repo: "acme/web" } }),
      entry(3, { level: "error", msg: "fetch failed", fields: { repo: "acme/api" } }),
    ];
    const { list, log } = await openLogs({ lines });
    expect(log.requests.at(-1)!.toString()).toBe("level=all");
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Warnings and errors" }));
    await waitFor(() => expect(shownMessages(list)).toEqual(["fetch was slow", "fetch failed"]));
    expect(log.requests.at(-1)!.get("level")).toBe("warn");

    await user.type(screen.getByRole("searchbox", { name: "Filter" }), "acme/API");
    await waitFor(() => expect(shownMessages(list)).toEqual(["fetch failed"]));
    expect(log.requests.at(-1)!.get("q")).toBe("acme/API");
    expect(log.requests.at(-1)!.get("level")).toBe("warn");

    await user.click(screen.getByRole("radio", { name: "All" }));
    await user.clear(screen.getByRole("searchbox", { name: "Filter" }));
    await waitFor(() => expect(shownMessages(list)).toHaveLength(3));
  });

  it("appends only live lines that match the filter", async () => {
    const { list, streams } = await openLogs({ lines: [entry(1)] });
    await userEvent.setup().click(screen.getByRole("radio", { name: "Warnings and errors" }));
    await waitFor(() => expect(shownMessages(list)).toEqual([]));
    sendLines(streams, [
      entry(5, { msg: "heartbeat sent" }),
      entry(6, { level: "warn", msg: "slow" }),
    ]);
    await waitFor(() => expect(shownMessages(list)).toEqual(["slow"]));
  });

  it("pages back with Load older", async () => {
    const lines = Array.from({ length: LOG_PAGE_SIZE + 30 }, (_, i) => entry(i));
    const { list, log } = await openLogs({ lines });
    expect(within(list).getAllByRole("listitem")).toHaveLength(LOG_PAGE_SIZE);
    expect(shownMessages(list)[0]).toBe("line 30");

    await userEvent.setup().click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")).toHaveLength(LOG_PAGE_SIZE + 30),
    );
    expect(log.requests.at(-1)!.get("before")).toBe(String(LOG_PAGE_SIZE));
    expect(shownMessages(list)[0]).toBe("line 0");
    expect(shownMessages(list).at(-1)).toBe(`line ${LOG_PAGE_SIZE + 29}`);
    // Nothing older.
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("expands a line's fields", async () => {
    const lines = [
      entry(1, { msg: "claimed a job", fields: { jobId: "job-1", attempt: { n: 2 } } }),
      entry(2, { msg: "idle" }),
    ];
    const { list } = await openLogs({ lines });
    const toggle = within(list).getByRole("button", { name: /claimed a job/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(list).queryByText("jobId")).toBeNull();
    // A line without fields has nothing to expand.
    expect(within(list).queryByRole("button", { name: /idle/ })).toBeNull();

    const user = userEvent.setup();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const fields = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(within(fields).getByText("jobId")).toBeDefined();
    expect(within(fields).getByText("job-1")).toBeDefined();
    expect(within(fields).getByText(/"n": 2/)).toBeDefined();

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(list).queryByText("jobId")).toBeNull();
  });

  it("appends new lines live and follows them at the bottom", async () => {
    const { list, streams } = await openLogs();
    const area = layOut(list);
    area.scrollTop = 800;
    fireEvent.scroll(area);

    sendLines(streams, [entry(3, { msg: "heartbeat sent" })]);
    await waitFor(() =>
      expect(shownMessages(list)).toEqual(["line 1", "line 2", "heartbeat sent"]),
    );
    expect(area.scrollTop).toBe(1_000);
  });

  it("keeps the scroll position when the reader has scrolled up", async () => {
    const { list, streams } = await openLogs();
    const area = layOut(list);
    area.scrollTop = 100;
    fireEvent.scroll(area);

    sendLines(streams, [entry(3, { msg: "heartbeat sent" })]);
    await waitFor(() => expect(shownMessages(list)).toHaveLength(3));
    expect(area.scrollTop).toBe(100);
  });

  it("holds new lines while paused and adds them on Resume", async () => {
    const { list, streams } = await openLogs();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Pause" }));

    sendLines(streams, [entry(3, { msg: "heartbeat sent" }), entry(4, { msg: "claimed" })]);
    expect((await screen.findByText("2 new lines while paused")).getAttribute("role")).toBe(
      "status",
    );
    expect(shownMessages(list)).toEqual(["line 1", "line 2"]);

    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(shownMessages(list)).toEqual(["line 1", "line 2", "heartbeat sent", "claimed"]);
    expect(screen.queryByText(/new lines? while paused/)).toBeNull();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
  });

  it("keeps at most 5,000 lines", { timeout: 30_000 }, async () => {
    const lines = Array.from({ length: LOG_PAGE_SIZE * 3 }, (_, i) => entry(i));
    const { list, streams } = await openLogs({ lines });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(400));

    // Three batches of live lines, as the live tail delivers them.
    let n = 10_000;
    for (let batch = 0; batch < 3; batch++) {
      sendLines(
        streams,
        Array.from({ length: LIVE_LOG_TAIL_SIZE }, () => entry(n++)),
      );
    }
    await waitFor(() => expect(shownMessages(list).at(-1)).toBe(`line ${n - 1}`));
    await waitFor(() => expect(list.querySelectorAll("li")).toHaveLength(MAX_LOG_LINES));
    // The older page went first; the newest page stays, then the newest live lines.
    const shown = shownMessages(list);
    expect(shown[0]).toBe(`line ${LOG_PAGE_SIZE * 2}`);
    expect(shown[LOG_PAGE_SIZE]).toBe(`line ${n - (MAX_LOG_LINES - LOG_PAGE_SIZE)}`);
    // At the cap, older pages would only push out what is there.
    expect(screen.getByText(AT_LINE_LIMIT)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("wraps lines and the toolbar at narrow widths", async () => {
    const { list } = await openLogs({ width: NARROW });
    expect(document.querySelector(".or-split[data-view=detail]")).not.toBeNull();
    expect(screen.getByRole("link", { name: /Agent/ })).toBeDefined();
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    const css = readFileSync(path.join(process.cwd(), "ui/src/styles.css"), "utf8");
    expect(css).toMatch(/\.agent-logs__toolbar\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(
      /\.agent-logs__msg\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*pre-wrap/,
    );
    const narrowStart = css.indexOf("@media (max-width: 768px)");
    const narrow = css.slice(narrowStart, css.indexOf("\n}\n", narrowStart));
    // The filter takes a row of its own: the toolbar wraps onto two rows.
    expect(narrow).toMatch(/\.agent-logs__filter\s*\{[^}]*flex:\s*1 1 100%/);
    expect(narrow).toMatch(/\.agent-logs__msg\s*\{[^}]*grid-column:\s*2 \/ -1/);
  });

  it("never names the old machine or shows a shortcut", async () => {
    await openLogs();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/h[a]rness|\bralph\b/i);
    expect(document.querySelector("kbd")).toBeNull();
  });
});

describe("the Logs page model", () => {
  it("pages like the agent", () => {
    expect(LOG_PAGE_SIZE).toBe(LOG_PAGE_LINES);
  });

  it("drops live lines the newest page holds", () => {
    const page = [entry(5), entry(5, { msg: "same time" }), entry(4)];
    const live = [entry(4), entry(5), entry(5, { msg: "another" }), entry(6)];
    expect(linesAfterPage(live, page)).toEqual([entry(5, { msg: "another" }), entry(6)]);
    expect(linesAfterPage(live, undefined)).toEqual(live);
    expect(linesAfterPage(live, [])).toEqual(live);
  });

  it("finds the tail's new entries", () => {
    const [a, b, c] = [entry(1), entry(2), entry(3)];
    expect(entriesAfter([a!, b!, c!], b!)).toEqual([c]);
    expect(entriesAfter([a!, b!], null)).toEqual([a, b]);
    // The seen entry left the tail: everything in it is new.
    expect(entriesAfter([b!, c!], entry(1))).toEqual([b, c]);
  });

  it("fits the cap by the oldest pages, then the oldest live lines", () => {
    expect(fitToCap([200, 200], 100)).toEqual({ dropPages: 0, keepLive: 100 });
    expect(fitToCap([200, 200, 200], 4_500)).toEqual({ dropPages: 1, keepLive: 4_500 });
    expect(fitToCap([200, 200], 6_000)).toEqual({ dropPages: 1, keepLive: 4_800 });
  });
});
