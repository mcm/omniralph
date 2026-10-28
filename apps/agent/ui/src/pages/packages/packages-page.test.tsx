// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import type { InstallRecord, InstallSummary } from "../../../../src/packages/history.js";
import {
  NARROW,
  WIDE,
  agentState,
  fakeApi,
  fakeEventSources,
  renderAgentPage,
  settingsState,
} from "../../test/page.js";
import { NO_PACKAGE_INSTALLABLE, PATTERN_INVALID } from "./model.js";

const REVISION = "a".repeat(64);
const NEXT_REVISION = "b".repeat(64);

beforeAll(() => {
  // jsdom lacks what Radix menus call.
  const proto = window.HTMLElement.prototype;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function install(overrides: Partial<InstallSummary> = {}): InstallSummary {
  return {
    id: "6f1d7a52-1111-4a8e-9f0a-1d2b3c4d5e6f",
    action: "install",
    name: "@omniralph/hello",
    version: "latest",
    installedVersion: "1.1.0",
    previousVersion: null,
    from: "local",
    startedAt: "2026-10-28T10:00:00.000Z",
    finishedAt: "2026-10-28T10:00:20.000Z",
    outcome: "installed",
    error: null,
    ...overrides,
  };
}

/** A card (also behind an open sheet, which hides the page from assistive tech). */
function region(name: string): HTMLElement {
  return screen.getByRole("region", { name, hidden: true });
}

/** The Installed card's table (the phone cards render beside it in jsdom). */
function installedTable(): HTMLElement {
  return within(region("Installed")).getByRole("table", { hidden: true });
}

/** The history table's rows (desktop), as their cells' text. */
function historyRows(): string[][] {
  const table = within(region("Install history")).getByRole("table", { hidden: true });
  return within(table)
    .getAllByRole("row", { hidden: true })
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell", { hidden: true })
        .map((cell) => cell.textContent ?? ""),
    );
}

function saveBar(): HTMLElement {
  return screen.getByRole("region", { name: "Unsaved changes" });
}

async function openPackages({
  settings = settingsState({ v: 1 }, { revision: REVISION }),
  packages = [{ name: "@omniralph/hello", version: "1.0.0" }],
  installs = [] as InstallSummary[],
  width = WIDE,
  path: at = "/packages",
  routes = {},
}: {
  settings?: ReturnType<typeof settingsState>;
  packages?: { name: string; version: string }[];
  installs?: InstallSummary[];
  width?: number;
  path?: string;
  routes?: Parameters<typeof fakeApi>[0];
} = {}) {
  const api = fakeApi({
    "/api/state": { body: agentState({ settings }) },
    "/api/packages": { body: { packages } },
    "/api/packages/history": { body: { installs } },
    ...routes,
  });
  const streams = fakeEventSources();
  renderAgentPage({ path: at, width, createEventSource: streams.create });
  await screen.findByRole("heading", { level: 2, name: "Packages", hidden: true });
  await screen.findByLabelText("Allowed packages");
  return { api, streams };
}

describe("the Packages page", () => {
  it("shows Installed, the allow-list and the install history with their copy", async () => {
    await openPackages({
      installs: [
        install({
          id: "b",
          from: "fleet",
          outcome: "failed",
          installedVersion: null,
          error: "E404",
        }),
        install({ id: "a" }),
      ],
    });
    const installed = region("Installed");
    expect(within(installed).getByRole("table", { name: "Installed packages" })).toBeTruthy();
    const cells = within(installedTable()).getAllByRole("cell");
    expect(cells[0]!.textContent).toBe("@omniralph/hello");
    expect(cells[0]!.classList.contains("or-mono")).toBe(true);
    expect(cells[1]!.textContent).toBe("1.0.0");
    expect(
      within(installedTable()).getByRole("button", { name: "Update @omniralph/hello" }),
    ).toBeTruthy();
    expect(within(installed).queryByText(NO_PACKAGE_INSTALLABLE)).toBeNull();

    const allow = region("Allow-list");
    expect(
      within(allow).getByText(
        "Package names or patterns this agent may install, such as @omniralph/*. Installs requested from Fleet follow it too.",
      ),
    ).toBeTruthy();
    expect(within(allow).getByText("@omniralph/*")).toBeTruthy();

    const header = within(within(region("Install history")).getByRole("table"))
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(header).toEqual(["Time", "Package", "From", "Outcome"]);
    const rows = historyRows();
    expect(rows.map((row) => row.slice(1))).toEqual([
      ["@omniralph/hello@latest", "Fleet", "Failed"],
      ["@omniralph/hello@1.1.0", "This machine", "Installed"],
    ]);
    // Failed in the fail tone.
    const failed = within(region("Install history")).getAllByRole("row")[1]!;
    expect(failed.classList.contains("or-tbl__row--bad")).toBe(true);
    expect(failed.querySelector(".or-status--fail")?.textContent).toBe("Failed");
    expect(document.body.textContent).not.toMatch(/harness|\bralph\b/i);
  });

  it("installs from the sheet, showing Installing… at once, then installed from the packages event", async () => {
    const answer = deferred<{ status: number; body: unknown }>();
    let packages = [{ name: "@omniralph/hello", version: "1.0.0" }];
    let installs: InstallSummary[] = [];
    let sent: unknown;
    const { api, streams } = await openPackages({
      routes: {
        "/api/packages": () => ({ body: { packages } }),
        "/api/packages/history": () => ({ body: { installs } }),
        "POST /api/packages": (init) => {
          sent = JSON.parse(String(init?.body));
          return answer.promise;
        },
      },
    });
    streams.latest().open();

    await userEvent.click(screen.getByRole("button", { name: "Install package…" }));
    const sheet = await screen.findByRole("dialog", { name: "Install package" });
    expect(
      within(sheet).getByText("Only packages that match the allow-list can be installed."),
    ).toBeTruthy();
    const version = within(sheet).getByLabelText("Version") as HTMLInputElement;
    expect(version.value).toBe("latest");
    await userEvent.type(within(sheet).getByLabelText("Package"), "@omniralph/graph");
    await userEvent.click(within(sheet).getByRole("button", { name: "Install" }));

    // Before the agent answered.
    expect(sent).toEqual({ name: "@omniralph/graph", version: "latest" });
    await waitFor(() =>
      expect(historyRows()[0]!.slice(1)).toEqual([
        "@omniralph/graph@latest",
        "This machine",
        "Installing @omniralph/graph…",
      ]),
    );

    const queued = install({
      id: "c",
      name: "@omniralph/graph",
      installedVersion: null,
      finishedAt: null,
      outcome: null,
    });
    installs = [queued];
    answer.resolve({ status: 202, body: queued });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(historyRows()).toHaveLength(1);

    // The agent finished: its packages event, no reload.
    installs = [{ ...queued, installedVersion: "2.0.0", outcome: "installed" }];
    packages = [...packages, { name: "@omniralph/graph", version: "2.0.0" }];
    const before = api.count("GET /api/packages/history");
    streams.latest().change({ resource: "packages", ids: ["c"] });
    await waitFor(() =>
      expect(historyRows()[0]!.slice(1)).toEqual([
        "@omniralph/graph@2.0.0",
        "This machine",
        "Installed",
      ]),
    );
    expect(api.count("GET /api/packages/history")).toBeGreaterThan(before);
    expect(within(installedTable()).getByText("@omniralph/graph")).toBeTruthy();
  });

  it("turns a queued install failed from the packages event", async () => {
    let installs = [install({ id: "c", installedVersion: null, finishedAt: null, outcome: null })];
    const { streams } = await openPackages({
      routes: { "/api/packages/history": () => ({ body: { installs } }) },
    });
    streams.latest().open();
    await waitFor(() => expect(historyRows()[0]![3]).toBe("Installing @omniralph/hello…"));
    installs = [{ ...installs[0]!, outcome: "failed", error: "npm error 404" }];
    streams.latest().change({ resource: "packages", ids: ["c"] });
    await waitFor(() => expect(historyRows()[0]![3]).toBe("Failed"));
  });

  it("refuses a package the allow-list doesn't match in the sheet, and shows the agent's error", async () => {
    const { api } = await openPackages({
      routes: {
        "POST /api/packages": {
          status: 403,
          body: { error: "@omniralph/x isn't allowed on this agent" },
        },
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Install package…" }));
    const sheet = await screen.findByRole("dialog", { name: "Install package" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Install" }));
    expect(within(sheet).getByText("Enter a package name.")).toBeTruthy();
    await userEvent.type(within(sheet).getByLabelText("Package"), "left-pad");
    await userEvent.click(within(sheet).getByRole("button", { name: "Install" }));
    expect(within(sheet).getByText("left-pad doesn't match the allow-list.")).toBeTruthy();
    expect(api.count("POST /api/packages")).toBe(0);

    await userEvent.clear(within(sheet).getByLabelText("Package"));
    await userEvent.type(within(sheet).getByLabelText("Package"), "@omniralph/x");
    await userEvent.click(within(sheet).getByRole("button", { name: "Install" }));
    expect(
      (await within(sheet).findByText("@omniralph/x isn't allowed on this agent")).getAttribute(
        "role",
      ),
    ).toBe("alert");
    // The optimistic row is rolled back.
    expect(screen.queryByText("Installing @omniralph/x…")).toBeNull();
  });

  it("updates a package to latest from its row, showing it at once", async () => {
    const answer = deferred<{ status: number; body: unknown }>();
    let sent: unknown;
    await openPackages({
      routes: {
        "POST /api/packages": (init) => {
          sent = JSON.parse(String(init?.body));
          return answer.promise;
        },
      },
    });
    await userEvent.click(
      within(installedTable()).getByRole("button", { name: "Update @omniralph/hello" }),
    );
    expect(sent).toEqual({ name: "@omniralph/hello", version: "latest" });
    await waitFor(() => expect(historyRows()[0]![3]).toBe("Installing @omniralph/hello…"));
    answer.resolve({
      status: 202,
      body: install({ id: "d", installedVersion: null, finishedAt: null, outcome: null }),
    });
  });

  it("removes a package after confirming, through Remove… in the ⋯ menu", async () => {
    const answer = deferred<{ status: number; body: unknown }>();
    const { api } = await openPackages({
      routes: { "DELETE /api/packages/%40omniralph%2Fhello": () => answer.promise },
    });
    await userEvent.click(
      within(installedTable()).getByRole("button", {
        name: "More actions for @omniralph/hello",
      }),
    );
    const menu = await screen.findByRole("menu");
    // After a divider.
    expect(within(menu).getByRole("separator")).toBeTruthy();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove @omniralph/hello?" });
    expect(
      within(dialog).getByText("Runs that need it won't be offered to this agent."),
    ).toBeTruthy();
    expect(api.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(api.calls).toContain("DELETE /api/packages/%40omniralph%2Fhello");
    await waitFor(() =>
      expect(historyRows()[0]!.slice(1)).toEqual([
        "@omniralph/hello@1.0.0",
        "This machine",
        "Removing @omniralph/hello…",
      ]),
    );
    answer.resolve({
      status: 202,
      body: install({
        id: "e",
        action: "remove",
        version: null,
        installedVersion: null,
        previousVersion: "1.0.0",
        finishedAt: null,
        outcome: null,
      }),
    });
  });

  it("validates allow-list patterns and lists each change with its effect", async () => {
    await openPackages();
    const input = screen.getByLabelText("Allowed packages");
    await userEvent.type(input, "two words{Enter}");
    expect(screen.getByText(PATTERN_INVALID)).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, "@acme/*{Enter}");
    expect(screen.queryByText(PATTERN_INVALID)).toBeNull();
    const items = () =>
      within(saveBar())
        .getAllByRole("listitem")
        .map((item) => [
          item.querySelector(".or-pending__label")?.textContent,
          item.querySelector(".or-pending__effect")?.textContent,
        ]);
    expect(items()).toEqual([["Allow @acme/*", "Packages matching @acme/* can be installed."]]);
  });

  it("says an empty allow-list means no package can be installed, and saves it", async () => {
    const refetch = deferred<{ body: unknown }>();
    let states = 0;
    let sent: unknown;
    const emptied = settingsState(
      { v: 1, installables: { allow: [] } },
      { revision: NEXT_REVISION },
    );
    const { api } = await openPackages({
      routes: {
        "/api/state": () =>
          ++states === 1
            ? { body: agentState({ settings: settingsState({ v: 1 }, { revision: REVISION }) }) }
            : refetch.promise,
        "PUT /api/settings/allow-list": (init) => {
          sent = JSON.parse(String(init?.body));
          return { body: emptied };
        },
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Remove @omniralph/*" }));
    const effect = saveBar().querySelector(".or-pending__effect");
    expect(effect?.textContent).toBe(NO_PACKAGE_INSTALLABLE);
    await userEvent.click(within(saveBar()).getByRole("button", { name: "Save" }));
    expect(sent).toEqual({ revision: REVISION, allow: [] });
    // Before the state's refetch answers: the Installed card says so and Install is disabled.
    await waitFor(() =>
      expect(within(region("Installed")).getByText(NO_PACKAGE_INSTALLABLE)).toBeTruthy(),
    );
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Install package…" }).getAttribute("aria-disabled"),
    ).toBe("true");
    await waitFor(() => expect(api.count("GET /api/state")).toBe(2));
    refetch.resolve({ body: agentState({ settings: emptied }) });
  });

  it("opens a history row's npm output in a sheet", async () => {
    const record: InstallRecord = {
      ...install({ id: "f", outcome: "failed", installedVersion: null, error: "E404" }),
      output: "npm error code E404\nnpm error 404 Not Found",
    };
    await openPackages({
      installs: [install({ id: "f", outcome: "failed", installedVersion: null, error: "E404" })],
      routes: { "/api/packages/history/f": { body: record } },
    });
    await userEvent.click(
      within(region("Install history")).getAllByRole("link", {
        name: "@omniralph/hello@latest",
      })[0]!,
    );
    const sheet = await screen.findByRole("dialog", { name: "@omniralph/hello@latest" });
    expect(window.location.pathname).toBe("/packages/history/f");
    const output = within(sheet).getByLabelText("npm output");
    expect(output.tagName).toBe("PRE");
    expect(output.classList.contains("or-mono")).toBe(true);
    expect(output.textContent).toBe("npm error code E404\nnpm error 404 Not Found");
    expect(within(sheet).getByRole("alert").textContent).toBe("E404");
    await userEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.pathname).toBe("/packages"));
  });

  it("refreshes an open install's output from the packages event", async () => {
    let record: InstallRecord = {
      ...install({ id: "g", installedVersion: null, finishedAt: null, outcome: null }),
      output: "",
    };
    const { streams } = await openPackages({
      path: "/packages/history/g",
      routes: { "/api/packages/history/g": () => ({ body: record }) },
    });
    streams.latest().open();
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("npm hasn't finished yet.")).toBeTruthy();
    record = { ...record, outcome: "installed", installedVersion: "1.1.0", output: "added 1" };
    streams.latest().change({ resource: "packages", ids: ["g"] });
    expect((await within(sheet).findByLabelText("npm output")).textContent).toBe("added 1");
  });

  it("turns both tables into cards at narrow widths", async () => {
    await openPackages({ width: NARROW, installs: [install()] });
    expect(document.querySelector(".or-split")?.getAttribute("data-view")).toBe("detail");
    for (const name of ["Installed packages", "Install history"]) {
      const cards = screen.getByRole("list", { name });
      expect(cards.classList.contains("or-cards")).toBe(true);
    }
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
