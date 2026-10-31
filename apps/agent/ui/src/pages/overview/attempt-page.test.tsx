// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { NEW_TAB_HINT } from "@omniralph/ui";
import { describe, expect, it } from "vitest";
import type { TailEvent } from "../../../../src/attempts/tail.js";
import {
  NARROW,
  WIDE,
  agentState,
  fakeApi,
  fakeEventSources,
  renderAgentPage,
} from "../../test/page.js";
import { RUN_ID, attempt, attemptPage, logLine, minutesAgo } from "./fixtures.js";
import {
  ATTEMPT_NOT_FOUND,
  NO_LOG_LINES,
  OPEN_RUN,
  TRANSCRIPT_PENDING,
  clockTimeSeconds,
} from "./model.js";
import type { AttemptPageState } from "./queries.js";

function event(overrides: Partial<TailEvent> = {}): TailEvent {
  return {
    type: "action",
    body: "Bash",
    parameter: "pnpm test",
    at: new Date().toISOString(),
    ...overrides,
  };
}

/** What the daemon answers now: a refetch reads it. */
interface Machine {
  attempt: AttemptPageState | null;
}

async function openAttempt(initial: AttemptPageState | null, { width = WIDE } = {}) {
  const id = initial?.id ?? "job-unknown";
  const machine: Machine = { attempt: initial };
  const api = fakeApi({
    "/api/state": () => ({ body: agentState() }),
    [`/api/attempts/${id}`]: () =>
      machine.attempt
        ? { body: machine.attempt }
        : { status: 404, body: { error: "This attempt isn't on this agent." } },
  });
  const streams = fakeEventSources();
  renderAgentPage({ path: `/attempts/${id}`, width, createEventSource: streams.create });
  await screen.findByRole("link", { name: "‹ Overview", hidden: true });
  return { api, streams, machine, id };
}

function transcript(): HTMLElement {
  return screen.getByRole("list", { name: "Transcript" });
}

function logLines(): string[] {
  const log = screen.queryByRole("list", { name: "Log", hidden: true });
  return log
    ? within(log)
        .getAllByRole("listitem", { hidden: true })
        .map((line) => line.querySelector(".agent-log__msg")?.textContent ?? "")
    : [];
}

describe("the Attempt page", () => {
  it("shows a running attempt: status, label, badges, run link, transcript and log", async () => {
    const running = attempt({ startedAt: minutesAgo(12) });
    const line = logLine(running.id, "claimed the job");
    await openAttempt(
      attemptPage(running, {
        events: [event({ type: "thought", body: "Reading the PRD.", parameter: null }), event()],
        log: [line],
      }),
    );

    const back = screen.getByRole("link", { name: "‹ Overview" });
    expect(back.getAttribute("href")).toBe("/overview");
    expect(await screen.findByRole("status", { name: "Running for 12m" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Building SOC-1720" })).toBeTruthy();
    const badges = document.querySelector(".agent-section .agent-attempt__badges")!;
    expect(badges.textContent).toBe("GitHub acme/customer-portalLinear SOC-1719Linear SOC-1720");

    const toolbar = await screen.findByRole("toolbar", { name: "Attempt actions" });
    const open = within(toolbar).getByRole("link", { name: `${OPEN_RUN} ${NEW_TAB_HINT}` });
    expect(open.getAttribute("href")).toBe(`https://omniralph.example.com/runs/${RUN_ID}`);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")?.split(" ")).toContain("noreferrer");

    const rows = within(transcript()).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("thinkingReading the PRD."),
      expect.stringContaining("Bashpnpm test"),
    ]);
    expect(screen.queryByRole("alert")).toBeNull();

    const details = screen.getByText("Log").closest("details")!;
    expect(details.querySelector(".agent-log__time")?.textContent).toBe(
      clockTimeSeconds(line.time),
    );
    expect(logLines()).toEqual(["claimed the job"]);
  });

  it("has no run link without a run, and says the transcript and log are empty", async () => {
    await openAttempt(attemptPage(attempt({ runId: null })));
    await screen.findByRole("status", { name: "Running for 12m" });
    expect(screen.queryByRole("toolbar", { name: "Attempt actions" })).toBeNull();
    expect(screen.queryByRole("link", { name: new RegExp(`^${OPEN_RUN}`) })).toBeNull();
    expect(screen.getByText(TRANSCRIPT_PENDING)).toBeTruthy();
    expect(screen.getByText(NO_LOG_LINES)).toBeTruthy();
  });

  it("shows a failed attempt's error after its transcript", async () => {
    const failed = attempt({
      startedAt: minutesAgo(3, Date.now()),
      finishedAt: minutesAgo(1),
      outcome: "failed",
      error: "pnpm test exited with 1",
      label: "Couldn't build SOC-1720",
    });
    await openAttempt(attemptPage(failed, { events: [event()] }));
    expect(await screen.findByRole("status", { name: "Failed after 2m" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Couldn't build SOC-1720" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("pnpm test exited with 1");
  });

  it("says Finished in for a completed attempt", async () => {
    const done = attempt({
      startedAt: minutesAgo(5),
      finishedAt: minutesAgo(1),
      outcome: "completed",
      label: "Built SOC-1720",
    });
    await openAttempt(attemptPage(done));
    expect(await screen.findByRole("status", { name: "Finished in 4m" })).toBeTruthy();
  });

  it("says an unknown attempt isn't on this agent", async () => {
    await openAttempt(null);
    expect(await screen.findByRole("heading", { name: ATTEMPT_NOT_FOUND })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("adds transcript events and log lines from their events, and changes the status when it finishes", async () => {
    const running = attempt({ startedAt: minutesAgo(12) });
    const { api, streams, machine, id } = await openAttempt(
      attemptPage(running, { events: [event({ parameter: "pnpm install" })], log: [] }),
    );
    streams.latest().open();
    await screen.findByRole("status", { name: "Running for 12m" });
    const fetches = api.count(`GET /api/attempts/${id}`);

    streams.latest().change({
      resource: "transcript",
      ids: [id],
      data: [event({ parameter: "pnpm test" })],
    });
    await waitFor(() => expect(within(transcript()).getAllByRole("listitem")).toHaveLength(2));
    expect(within(transcript()).getAllByRole("listitem")[1]!.textContent).toContain("pnpm test");

    const liveLine = logLine(id, "running the tests");
    streams.latest().change({
      resource: "logs",
      data: [liveLine, logLine("job-other", "someone else's line")],
    });
    await waitFor(() => expect(logLines()).toEqual(["running the tests"]));
    // Both came with their events, not from a refetch.
    expect(api.count(`GET /api/attempts/${id}`)).toBe(fetches);

    machine.attempt = attemptPage(
      { ...running, outcome: "completed", finishedAt: minutesAgo(0), label: "Built SOC-1720" },
      {
        events: [event({ parameter: "pnpm install" }), event({ parameter: "pnpm test" })],
        log: [liveLine],
      },
    );
    streams.latest().change({ resource: "attempts", ids: [id] });
    expect(await screen.findByRole("status", { name: "Finished in 12m" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Built SOC-1720" })).toBeTruthy();
    expect(within(transcript()).getAllByRole("listitem")).toHaveLength(2);
    // The refetched log has the live line: it shows once.
    expect(logLines()).toEqual(["running the tests"]);
  });

  it("never shows the job type", async () => {
    const running = attempt();
    await openAttempt(attemptPage(running, { events: [event()] }));
    await screen.findByRole("status", { name: "Running for 12m" });
    expect(document.body.textContent).not.toContain(running.type);
  });

  it("opens full screen at narrow widths with its own back link", async () => {
    await openAttempt(attemptPage(attempt(), { events: [event()] }), { width: NARROW });
    await screen.findByRole("status", { name: "Running for 12m" });
    expect(document.querySelector(".or-split")?.getAttribute("data-view")).toBe("detail");
    expect(screen.getByRole("link", { name: "‹ Overview" }).getAttribute("href")).toBe("/overview");
    expect(screen.getByRole("list", { name: "Transcript" })).toBeTruthy();
    const css = readFileSync(path.join(process.cwd(), "ui/src/styles.css"), "utf8");
    const start = css.indexOf("@media (max-width: 768px)");
    const narrow = css.slice(start, css.indexOf("\n}\n", start));
    // A log line's message wraps under its time and level.
    expect(narrow).toMatch(/\.agent-log__msg\s*\{[^}]*grid-column:\s*1 \/ -1/);
  });
});
