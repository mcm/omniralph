// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AgentUiHostTool, AgentUiHostTools } from "../../../../src/ui/state.js";
import {
  NARROW,
  WIDE,
  agentState,
  fakeApi,
  fakeEventSources,
  renderAgentPage,
  settingsState,
} from "../../test/page.js";
import { NAME_INVALID, NEVER_RUN_FROM_DESCRIPTION, PATH_NOT_ABSOLUTE } from "./model.js";

const REVISION = "a".repeat(64);
const NEXT_REVISION = "b".repeat(64);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tool(overrides: Partial<AgentUiHostTool> & { name: string }): AgentUiHostTool {
  return {
    path: null,
    source: null,
    problem: null,
    checkedPath: null,
    required: false,
    ...overrides,
  };
}

/** A card (also behind an open sheet, which hides the page from assistive tech). */
function region(name: string): HTMLElement {
  return screen.getByRole("region", { name, hidden: true });
}

/** The tools table's rows (desktop), as their cells' text. */
function rows(): string[][] {
  const table = within(region("Tools")).getByRole("table", { hidden: true });
  return within(table)
    .getAllByRole("row", { hidden: true })
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell", { hidden: true })
        .slice(0, 3)
        .map((cell) => cell.textContent ?? ""),
    );
}

function row(name: string): HTMLElement {
  const table = within(region("Tools")).getByRole("table", { hidden: true });
  return within(table)
    .getAllByRole("row", { hidden: true })
    .find((tr) =>
      within(tr).queryAllByRole("cell", { hidden: true })[0]?.textContent?.startsWith(name),
    )!;
}

const SAMPLE: AgentUiHostTools = {
  required: ["gh", "opengrep", "semgrep"],
  blockedExecPaths: ["/tmp", "/home/build/.cache"],
  tools: [
    tool({
      name: "gh",
      path: "/usr/bin/gh",
      source: "discovered",
      required: true,
    }),
    tool({
      name: "jq",
      path: "/opt/jq/bin/jq",
      source: "configured",
      checkedPath: "/opt/jq/bin/jq",
    }),
    tool({ name: "opengrep", required: true }),
    tool({ name: "ruff", problem: "not_executable", checkedPath: "/opt/ruff" }),
    tool({ name: "semgrep", problem: "blocked", checkedPath: "/tmp/semgrep", required: true }),
    tool({ name: "yq" }),
  ],
};

const SAMPLE_SETTINGS = {
  v: 1 as const,
  hostTools: { jq: "/opt/jq/bin/jq", ruff: "/opt/ruff", semgrep: "/tmp/semgrep" },
};

/** What `/api/state` answers now: a save or an event's refetch reads it. */
interface Machine {
  settings: ReturnType<typeof settingsState>;
  hostTools: AgentUiHostTools;
}

async function openHostTools({
  settings = settingsState(SAMPLE_SETTINGS, { revision: REVISION }),
  hostTools = SAMPLE,
  width = WIDE,
  routes = () => ({}),
}: {
  settings?: ReturnType<typeof settingsState>;
  hostTools?: AgentUiHostTools;
  width?: number;
  routes?: (machine: Machine) => Parameters<typeof fakeApi>[0];
} = {}) {
  const machine: Machine = { settings, hostTools };
  const api = fakeApi({
    "/api/state": () => ({
      body: agentState({ settings: machine.settings, hostTools: machine.hostTools }),
    }),
    ...routes(machine),
  });
  const streams = fakeEventSources();
  renderAgentPage({ path: "/host-tools", width, createEventSource: streams.create });
  await screen.findByRole("heading", { level: 2, name: "Host tools", hidden: true });
  await screen.findByRole("region", { name: "Tools" });
  return { api, streams, machine };
}

/** Saves answer like the agent: the file now holds the map. */
function savesMap(machine: Machine, sent: unknown[]) {
  return (init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body)) as { hostTools: Record<string, string> };
    sent.push(body);
    machine.settings = settingsState(
      Object.keys(body.hostTools).length ? { v: 1, hostTools: body.hostTools } : { v: 1 },
      { revision: NEXT_REVISION },
    );
    return { body: machine.settings };
  };
}

describe("the Host tools page", () => {
  it("lists each tool with Required, its status and path, and the Never run from card", async () => {
    await openHostTools();
    expect(screen.getByRole("table", { name: "Host tools" })).toBeTruthy();
    const headers = within(screen.getByRole("table", { name: "Host tools" }))
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers.slice(0, 3)).toEqual(["Name", "Status", "Path"]);
    expect(rows()).toEqual([
      ["ghRequired", "Found on PATH", "/usr/bin/gh"],
      ["jq", "Configured", "/opt/jq/bin/jq"],
      ["opengrepRequired", "Not found", "—"],
      ["ruff", "Not executable", "/opt/ruff"],
      ["semgrepRequired", "Blocked", "/tmp/semgrep"],
      ["yq", "Not found", "—"],
    ]);
    // Names and paths are mono; a missing required tool and problems are in the fail tone.
    expect(within(row("gh")).getByText("gh").classList.contains("or-mono")).toBe(true);
    const pathCell = within(row("gh")).getAllByRole("cell")[2]!;
    expect(pathCell.classList.contains("or-mono")).toBe(true);
    const status = (name: string, text: string) => within(row(name)).getByText(text);
    expect(status("opengrep", "Not found").classList.contains("or-status--fail")).toBe(true);
    expect(status("yq", "Not found").classList.contains("or-status--fail")).toBe(false);
    expect(status("ruff", "Not executable").classList.contains("or-status--fail")).toBe(true);
    expect(status("semgrep", "Blocked").classList.contains("or-status--fail")).toBe(true);
    expect(within(row("gh")).getByRole("button", { name: "Set path for gh…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add host tool…" })).toBeTruthy();

    const never = region("Never run from");
    expect(within(never).getByText(NEVER_RUN_FROM_DESCRIPTION)).toBeTruthy();
    expect(NEVER_RUN_FROM_DESCRIPTION).toBe("The agent never runs a program from these paths.");
    const paths = within(never)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(paths).toEqual(["/tmp", "/home/build/.cache"]);
    // Read-only: nothing to edit there.
    expect(within(never).queryByRole("textbox")).toBeNull();
    expect(within(never).queryByRole("button")).toBeNull();
  });

  it("refuses a relative path in Set path…", async () => {
    const { api } = await openHostTools();
    await userEvent.click(within(row("gh")).getByRole("button", { name: "Set path for gh…" }));
    const sheet = await screen.findByRole("dialog", { name: "Set path for gh" });
    await userEvent.type(within(sheet).getByLabelText("Path"), "bin/gh");
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(within(sheet).getByText(PATH_NOT_ABSOLUTE)).toBeTruthy();
    expect(PATH_NOT_ABSOLUTE).toBe("Use an absolute path");
    expect(api.count("PUT /api/settings/host-tools")).toBe(0);
  });

  it("shows a set path at once as Checking…, then the agent's check from the host_tools event", async () => {
    const answer = deferred<{ status: number; body: unknown }>();
    let sent: unknown;
    const { api, streams, machine } = await openHostTools({
      routes: () => ({
        "PUT /api/settings/host-tools": (init) => {
          sent = JSON.parse(String(init?.body));
          return answer.promise;
        },
      }),
    });
    streams.latest().open();

    await userEvent.click(within(row("gh")).getByRole("button", { name: "Set path for gh…" }));
    const sheet = await screen.findByRole("dialog", { name: "Set path for gh" });
    await userEvent.type(within(sheet).getByLabelText("Path"), "/opt/gh/bin/gh");
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));

    // Before the agent answered: the whole map, and the row shows the path being checked.
    expect(sent).toEqual({
      revision: REVISION,
      hostTools: { ...SAMPLE_SETTINGS.hostTools, gh: "/opt/gh/bin/gh" },
    });
    await waitFor(() => expect(rows()[0]).toEqual(["ghRequired", "Checking…", "/opt/gh/bin/gh"]));
    expect(screen.queryByRole("dialog")).toBeNull();

    const saved = {
      ...SAMPLE_SETTINGS,
      hostTools: { ...SAMPLE_SETTINGS.hostTools, gh: "/opt/gh/bin/gh" },
    };
    machine.settings = settingsState(saved, { revision: NEXT_REVISION });
    answer.resolve({ status: 200, body: machine.settings });
    await screen.findByText("gh path saved");
    // The agent hasn't checked it yet.
    expect(rows()[0]).toEqual(["ghRequired", "Checking…", "/opt/gh/bin/gh"]);

    // Its heartbeat checked the path: the host_tools event, no reload.
    machine.hostTools = {
      ...SAMPLE,
      tools: SAMPLE.tools.map((entry) =>
        entry.name === "gh"
          ? {
              ...entry,
              path: "/opt/gh/bin/gh",
              source: "configured",
              checkedPath: "/opt/gh/bin/gh",
            }
          : entry,
      ),
    };
    const before = api.count("GET /api/state");
    streams.latest().change({ resource: "host_tools" });
    await waitFor(() => expect(rows()[0]).toEqual(["ghRequired", "Configured", "/opt/gh/bin/gh"]));
    expect(api.count("GET /api/state")).toBeGreaterThan(before);
  });

  it("goes back to PATH with Use PATH", async () => {
    const sent: unknown[] = [];
    await openHostTools({
      routes: (machine) => ({ "PUT /api/settings/host-tools": savesMap(machine, sent) }),
    });
    await userEvent.click(within(row("gh")).getByRole("button", { name: "Set path for gh…" }));
    let sheet = await screen.findByRole("dialog", { name: "Set path for gh" });
    // Nothing configured for gh: nothing to clear.
    expect(
      (within(sheet).getByRole("button", { name: "Use PATH" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(within(row("jq")).getByRole("button", { name: "Set path for jq…" }));
    sheet = await screen.findByRole("dialog", { name: "Set path for jq" });
    expect((within(sheet).getByLabelText("Path") as HTMLInputElement).value).toBe("/opt/jq/bin/jq");
    await userEvent.click(within(sheet).getByRole("button", { name: "Use PATH" }));
    expect(sent[0]).toEqual({
      revision: REVISION,
      hostTools: { ruff: "/opt/ruff", semgrep: "/tmp/semgrep" },
    });
    // At once: jq is no longer configured, and goes at the next check.
    await waitFor(() =>
      expect(rows().find(([name]) => name === "jq")).toEqual(["jq", "Checking…", "—"]),
    );
    await screen.findByText("jq is looked up on PATH");
  });

  it("adds a host tool by name and path, refusing an invalid name", async () => {
    const sent: unknown[] = [];
    await openHostTools({
      routes: (machine) => ({ "PUT /api/settings/host-tools": savesMap(machine, sent) }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Add host tool…" }));
    const sheet = await screen.findByRole("dialog", { name: "Add host tool" });
    await userEvent.type(within(sheet).getByLabelText("Name"), "Open Grep");
    await userEvent.type(within(sheet).getByLabelText("Path"), "/usr/local/bin/opengrep");
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(within(sheet).getByText(NAME_INVALID)).toBeTruthy();
    expect(sent).toEqual([]);

    await userEvent.clear(within(sheet).getByLabelText("Name"));
    await userEvent.type(within(sheet).getByLabelText("Name"), "jq");
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(within(sheet).getByText("jq already has a path")).toBeTruthy();

    await userEvent.clear(within(sheet).getByLabelText("Name"));
    await userEvent.type(within(sheet).getByLabelText("Name"), "opengrep");
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(sent).toEqual([
      {
        revision: REVISION,
        hostTools: { ...SAMPLE_SETTINGS.hostTools, opengrep: "/usr/local/bin/opengrep" },
      },
    ]);
    await waitFor(() =>
      expect(rows().find(([name]) => name === "opengrepRequired")).toEqual([
        "opengrepRequired",
        "Checking…",
        "/usr/local/bin/opengrep",
      ]),
    );
  });

  it("rolls a set path back when settings.json changed on the machine", async () => {
    const latest = settingsState(
      { v: 1, hostTools: { ...SAMPLE_SETTINGS.hostTools, yq: "/usr/bin/yq" } },
      { revision: NEXT_REVISION },
    );
    await openHostTools({
      routes: (machine) => ({
        "PUT /api/settings/host-tools": () => {
          // A hand edit got there first.
          machine.settings = latest;
          return {
            status: 409,
            body: {
              error: "These settings changed on the machine. Review and save again.",
              settings: latest,
            },
          };
        },
      }),
    });
    await userEvent.click(within(row("gh")).getByRole("button", { name: "Set path for gh…" }));
    const sheet = await screen.findByRole("dialog", { name: "Set path for gh" });
    await userEvent.type(within(sheet).getByLabelText("Path"), "/opt/gh/bin/gh");
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await screen.findByText("These settings changed on the machine. Review and save again.");
    await waitFor(() => expect(rows()[0]).toEqual(["ghRequired", "Found on PATH", "/usr/bin/gh"]));
    // The file's current settings: yq is configured there, and checked next.
    await waitFor(() =>
      expect(rows().find(([name]) => name === "yq")).toEqual(["yq", "Checking…", "/usr/bin/yq"]),
    );
  });

  it("says when settings.json isn't valid", async () => {
    await openHostTools({
      settings: settingsState(SAMPLE_SETTINGS, {
        revision: REVISION,
        lastError: "hostTools.gh: must be an absolute path",
      }),
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "settings.json isn't valid: hostTools.gh: must be an absolute path; the agent keeps its last good settings",
    );
  });

  it("opens full screen with a back link and turns the table into cards at narrow widths", async () => {
    await openHostTools({ width: NARROW });
    expect(document.querySelector(".or-split")?.getAttribute("data-view")).toBe("detail");
    expect(screen.getByRole("link", { name: "Agent" })).toBeTruthy();
    const cards = screen.getByRole("list", { name: "Host tools" });
    expect(cards.classList.contains("or-cards")).toBe(true);
    expect(within(cards).getByText("opengrep")).toBeTruthy();
    // `DataTable`'s own rule: the table hides and the cards show at 768 px and narrower.
    const require = createRequire(import.meta.url);
    const css = readFileSync(
      path.join(path.dirname(require.resolve("@omniralph/ui/styles.css")), "lists.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const narrow = /@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(narrow).toMatch(/\.or-tblwrap\s*\{[^}]*display:\s*none/);
    expect(narrow).toMatch(/\.or-cards\s*\{[^}]*display:\s*flex/);
  });
});
