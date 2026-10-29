// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { LABELED_JOB_TYPES, describeAttempt, type AttemptStatus } from "@omniralph/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AttemptRecord } from "../../../../src/attempts/history.js";
import type { AgentUiState } from "../../state.js";
import {
  NARROW,
  WIDE,
  agentState,
  fakeApi,
  fakeEventSources,
  settingsState,
  updateState,
} from "../../test/page.js";
import { renderAgentPage } from "../../test/page.js";
import { attempt, minutesAgo } from "./fixtures.js";
import { CLAUDE_SIGNED_OUT, NOTHING_RUNNING, NO_RECENT_WORK, REVOKED, clockTime } from "./model.js";

const GB = 1_000_000_000;
const SIGNED_IN: AgentUiState["claude"] = {
  status: "signed_in",
  source: "login",
  account: { email: "steve@example.com", organization: "Example", subscriptionType: "max" },
  models: [],
  checkedAt: "2026-10-28T10:00:00.000Z",
};

/** A healthy agent: connected, idle, up to date, signed in, plenty of disk. */
function healthy(overrides: Partial<AgentUiState> = {}): AgentUiState {
  const state = agentState({ claude: SIGNED_IN });
  return {
    ...state,
    filesystems: [{ paths: ["/home/ci"], freeBytes: 120 * GB, totalBytes: 500 * GB, low: false }],
    ...overrides,
  };
}

function withConnection(
  state: AgentUiState,
  connection: Partial<AgentUiState["connection"]>,
): AgentUiState {
  return { ...state, connection: { ...state.connection, ...connection } };
}

/** What the daemon answers now: a refetch reads it. */
interface Machine {
  state: AgentUiState;
  running: AttemptRecord[];
  recent: AttemptRecord[];
}

async function openOverview({
  state = healthy(),
  running = [],
  recent = [],
  path = "/",
  width = WIDE,
}: Partial<Machine> & { path?: string; width?: number } = {}) {
  const machine: Machine = { state, running, recent };
  const api = fakeApi({
    "/api/state": () => ({ body: machine.state }),
    "/api/attempts": () => ({ body: { running: machine.running, recent: machine.recent } }),
  });
  const streams = fakeEventSources();
  renderAgentPage({ path, width, createEventSource: streams.create });
  await screen.findByRole("heading", { level: 2, name: "Overview", hidden: true });
  await screen.findByRole("region", { name: "Summary" });
  await screen.findByRole("region", { name: "Running now" });
  return { api, streams, machine };
}

function cells(): Record<string, string> {
  const summary = screen.getByRole("region", { name: "Summary" });
  return Object.fromEntries(
    within(summary)
      .getAllByRole("group")
      .map((cell) => {
        const label = cell.querySelector(".or-stats__label")?.textContent ?? "";
        return [label, (cell.textContent ?? "").slice(label.length)];
      }),
  );
}

function cell(label: string): HTMLElement {
  return within(screen.getByRole("region", { name: "Summary" })).getByRole("group", {
    name: label,
  });
}

function statusLine(): HTMLElement | null {
  return document.querySelector(".or-statusline");
}

describe("the Overview page", () => {
  it("shows no status line for a healthy agent, and the summary", async () => {
    await openOverview();
    expect(statusLine()).toBeNull();
    expect(cells()).toEqual({
      Slots: "Idle",
      Version: "2.0.3Up to date",
      Claude: "Signed inClaude login",
      Disk: "120 GB freeof 500 GB",
    });
    // The running version is a badge, as on the Version page (Design rule 1).
    expect(cell("Version").querySelector("[data-or-badge]")?.textContent).toBe("2.0.3");
    expect(cell("Disk").querySelector(".or-status--fail")).toBeNull();
  });

  it("says Nothing running and No recent work when there is none", async () => {
    await openOverview();
    expect(
      within(screen.getByRole("region", { name: "Running now" })).getByText(NOTHING_RUNNING),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Recent work" })).getByText(NO_RECENT_WORK),
    ).toBeTruthy();
  });

  const unreachableSince = "2026-10-28T10:42:00.000Z";
  const problems: [string, AgentUiState, string, string][] = [
    [
      "the control panel can't be reached",
      withConnection(healthy(), { unreachableSince }),
      `Can't reach the control panel since ${clockTime(unreachableSince)}`,
      "fail",
    ],
    [
      "the agent was revoked",
      withConnection(healthy(), { revoked: true, unreachableSince }),
      REVOKED,
      "fail",
    ],
    [
      "the agent is finishing its work to update",
      healthy({ update: updateState({ state: "draining", version: "2.0.4" }) }),
      "Finishing running work before updating to 2.0.4",
      "neutral",
    ],
    [
      "Update now was asked for",
      healthy({
        update: updateState({
          request: { version: "2.0.4", requestedAt: "2026-10-28T10:00:00.000Z" },
        }),
      }),
      "Finishing running work before updating to 2.0.4",
      "neutral",
    ],
    [
      "Claude isn't signed in",
      healthy({ claude: { ...SIGNED_IN!, status: "signed_out", source: null } }),
      CLAUDE_SIGNED_OUT,
      "fail",
    ],
    [
      "several things are wrong (the first wins)",
      withConnection(
        healthy({
          claude: { ...SIGNED_IN!, status: "signed_out", source: null },
          update: updateState({ state: "draining", version: "2.0.4" }),
        }),
        { unreachableSince },
      ),
      `Can't reach the control panel since ${clockTime(unreachableSince)}`,
      "fail",
    ],
    [
      "an update drains while Claude is signed out",
      healthy({
        claude: { ...SIGNED_IN!, status: "signed_out", source: null },
        update: updateState({ state: "draining", version: "2.0.4" }),
      }),
      "Finishing running work before updating to 2.0.4",
      "neutral",
    ],
  ];

  it.each(problems)("shows the status line when %s", async (_, state, text, tone) => {
    await openOverview({ state });
    const line = await screen.findByRole("status", { name: text });
    expect(line.classList.contains(`or-statusline--${tone}`)).toBe(true);
    expect(document.querySelectorAll(".or-statusline")).toHaveLength(1);
  });

  it("summarizes busy slots, an update, Claude signed out and low disk", async () => {
    await openOverview({
      state: healthy({
        status: { ...healthy().status, runningJobIds: ["a", "b"], maxConcurrency: 4 },
        update: updateState({ state: "installing", version: "2.0.4" }),
        claude: { ...SIGNED_IN!, status: "signed_out", source: null },
        filesystems: [
          { paths: ["/home/ci"], freeBytes: 120 * GB, totalBytes: 500 * GB, low: false },
          { paths: ["/data"], freeBytes: 3 * GB, totalBytes: 500 * GB, low: true },
        ],
      }),
    });
    expect(cells()).toEqual({
      Slots: "2 of 4 busy",
      Version: "2.0.3Updating to 2.0.4",
      Claude: "Not signed in",
      Disk: "3 GB freeof 500 GB",
    });
    expect(cell("Claude").querySelector(".or-status--fail")?.textContent).toBe("Not signed in");
    expect(cell("Disk").querySelector(".or-status--fail")?.textContent).toBe("3 GB free");
  });

  it("says a failed update in the fail tone, and a pin", async () => {
    await openOverview({
      state: healthy({
        update: updateState({ version: "2.0.4", error: "npm failed", failedVersions: ["2.0.4"] }),
      }),
    });
    expect(cells().Version).toBe("2.0.3Update to 2.0.4 failed");
    expect(cell("Version").querySelector(".or-status--fail")?.textContent).toBe(
      "Update to 2.0.4 failed",
    );
  });

  it("says Pinned to when the agent pins its version", async () => {
    await openOverview({
      state: healthy({ settings: settingsState({ v: 1, update: { pin: "2.0.3" } }) }),
    });
    expect(cells().Version).toBe("2.0.3Pinned to 2.0.3");
  });

  it("lists what runs now and the recent work, failed attempts in the fail tone", async () => {
    const running = attempt();
    const done = attempt({ outcome: "completed", story: "SOC-1721" });
    const failed = attempt({ outcome: "failed", story: "SOC-1722", error: "tests failed" });
    await openOverview({ running: [running], recent: [failed, done] });

    const now = within(screen.getByRole("list", { name: "Running now" }));
    const link = now.getByRole("link", { name: "Building SOC-1720" });
    expect(link.getAttribute("href")).toBe(`/attempts/${running.id}`);
    const row = link.closest("li")!;
    expect(row.textContent).toContain("acme/customer-portal");
    expect(row.textContent).toContain("SOC-1719");
    expect(row.querySelector(".agent-attempt__elapsed")?.textContent).toBe("12m");

    const recent = within(screen.getByRole("list", { name: "Recent work" }));
    expect(
      recent.getAllByRole("listitem").map((item) => item.querySelector("a")?.textContent),
    ).toEqual(["Couldn't build SOC-1722", "Built SOC-1721"]);
    const failedLink = recent.getByRole("link", { name: "Couldn't build SOC-1722" });
    expect(failedLink.getAttribute("href")).toBe(`/attempts/${failed.id}`);
    expect(failedLink.querySelector(".or-status--fail")).not.toBeNull();
    expect(
      recent.getByRole("link", { name: "Built SOC-1721" }).querySelector(".or-status--fail"),
    ).toBeNull();
  });

  it("moves a finished attempt from Running now to Recent work from its event", async () => {
    const running = attempt();
    const { streams, machine, api } = await openOverview({
      state: healthy({ status: { ...healthy().status, runningJobIds: [running.id] } }),
      running: [running],
    });
    streams.latest().open();
    expect(cells().Slots).toBe("1 of 5 busy");
    const before = api.count("GET /api/attempts");

    const finished = attempt({ ...running, outcome: "completed", finishedAt: minutesAgo(0) });
    finished.label = "Built SOC-1720";
    machine.running = [];
    machine.recent = [finished];
    machine.state = healthy();
    streams.latest().change({ resource: "attempts", ids: [running.id] });

    await within(screen.getByRole("region", { name: "Running now" })).findByText(NOTHING_RUNNING);
    expect(
      within(screen.getByRole("list", { name: "Recent work" })).getByRole("link", {
        name: "Built SOC-1720",
      }),
    ).toBeTruthy();
    await waitFor(() => expect(cells().Slots).toBe("Idle"));
    expect(api.count("GET /api/attempts")).toBe(before + 1);
  });

  it("shows the status line as soon as the agent can't reach the control panel", async () => {
    const { streams, machine } = await openOverview();
    streams.latest().open();
    expect(statusLine()).toBeNull();
    machine.state = withConnection(healthy(), { unreachableSince: "2026-10-28T10:42:00.000Z" });
    streams.latest().change({ resource: "status" });
    await screen.findByRole("status", {
      name: `Can't reach the control panel since ${clockTime("2026-10-28T10:42:00.000Z")}`,
    });
  });

  it("never shows a raw job type", async () => {
    const statuses: (AttemptStatus & ("completed" | "failed" | "canceled"))[] = [
      "completed",
      "failed",
      "canceled",
    ];
    const label = (type: string, status: AttemptStatus) =>
      describeAttempt({
        type,
        status,
        context: {
          workItem: "SOC-1719",
          story: "SOC-1720",
          repository: "acme/customer-portal",
          provider: "github",
          pullRequestNumber: 42,
          packageName: "@acme/tools",
        },
      });
    const types = [...LABELED_JOB_TYPES, "review.run", "ralph.prepare", "ralph.cleanup"];
    const running = types.map((type) => attempt({ type, label: label(type, "running") }));
    const recent = types.flatMap((type) =>
      statuses.map((status) =>
        attempt({ type, outcome: status, label: label(type, status), error: "boom" }),
      ),
    );
    await openOverview({ running, recent });
    await userEvent.click(screen.getByRole("button", { name: `Show all ${recent.length}` }));
    const text = document.body.textContent ?? "";
    expect(
      within(screen.getByRole("list", { name: "Recent work" })).getAllByRole("listitem"),
    ).toHaveLength(recent.length);
    // A one-word type ("install") is also the English verb its label uses.
    const rawTypes = types.filter((type) => /[._:-]/.test(type));
    expect(rawTypes.length).toBeGreaterThan(types.length / 2);
    for (const type of rawTypes) expect(text).not.toContain(type);
    for (const fixture of [...running, ...recent]) expect(text).toContain(fixture.label);
    expect(text).not.toMatch(/h[a]rness|\bralph\b/i);
  });

  it("opens full screen with a back link at narrow widths", async () => {
    await openOverview({ path: "/overview", width: NARROW, running: [attempt()] });
    expect(document.querySelector(".or-split")?.getAttribute("data-view")).toBe("detail");
    expect(screen.getByRole("link", { name: "Agent" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("list", { name: "Running now" })).toBeTruthy();
    const css = readFileSync(path.join(process.cwd(), "ui/src/styles.css"), "utf8");
    const start = css.indexOf("@media (max-width: 768px)");
    const narrow = css.slice(start, css.indexOf("\n}\n", start));
    // A running attempt's badges go under its sentence.
    expect(narrow).toMatch(
      /\.agent-attempt\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/,
    );
    expect(narrow).toMatch(/\.agent-attempt__badges\s*\{[^}]*grid-row:\s*2/);
  });

  it("shows Overview beside the nav on / when wide", async () => {
    await openOverview({ path: "/", width: WIDE });
    expect(document.querySelector(".or-split")?.getAttribute("data-view")).toBe("list");
    expect(screen.getByRole("navigation", { name: "Agent" })).toBeTruthy();
  });
});
