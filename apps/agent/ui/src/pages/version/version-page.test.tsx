// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AgentUiState } from "../../state.js";
import {
  NARROW,
  WIDE,
  agentState,
  fakeApi,
  fakeEventSources,
  renderAgentPage,
  settingsState,
  updateState,
} from "../../test/page.js";
import { NOT_UNDER_PM2, PIN_DESCRIPTION, PIN_TOO_OLD } from "./model.js";

const REVISION = "a".repeat(64);
const NEXT_REVISION = "b".repeat(64);
const LATEST = { kind: "latest", version: "2.0.4" } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** What `/api/state` answers now: a save or an event's refetch reads it. */
interface Machine {
  settings: ReturnType<typeof settingsState>;
  update: AgentUiState["update"];
  versionPolicy: AgentUiState["versionPolicy"];
}

async function openVersion({
  settings = settingsState({ v: 1 }, { revision: REVISION }),
  update = updateState(),
  versionPolicy = LATEST,
  width = WIDE,
  routes = () => ({}),
}: {
  settings?: ReturnType<typeof settingsState>;
  update?: AgentUiState["update"];
  versionPolicy?: AgentUiState["versionPolicy"];
  width?: number;
  routes?: (machine: Machine) => Parameters<typeof fakeApi>[0];
} = {}) {
  const machine: Machine = { settings, update, versionPolicy };
  const api = fakeApi({
    "/api/state": () => ({ body: agentState(machine) }),
    ...routes(machine),
  });
  const streams = fakeEventSources();
  renderAgentPage({ path: "/version", width, createEventSource: streams.create });
  await screen.findByRole("heading", { level: 2, name: "Version", hidden: true });
  await screen.findByRole("region", { name: "Pin a version" });
  return { api, streams, machine };
}

/** The summary's cells, as "label: value". */
function summary(): string[] {
  const cells = screen.getByRole("region", { name: "Version summary", hidden: true });
  return within(cells)
    .getAllByRole("group", { hidden: true })
    .map((cell) => cell.textContent ?? "");
}

function updateNow(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Update now", hidden: true }) as HTMLButtonElement;
}

/** Disabled with a reason stays focusable (`aria-disabled`), so its tooltip can say why. */
function disabled(button: HTMLButtonElement): boolean {
  return button.disabled || button.getAttribute("aria-disabled") === "true";
}

function updateCell(): HTMLElement {
  return screen.getByRole("group", { name: "Update", hidden: true });
}

describe("the Version page", () => {
  it("shows the running version, the organization's policy and that it's up to date (idle)", async () => {
    await openVersion({ versionPolicy: { kind: "latest", version: "2.0.3" } });
    expect(summary()).toEqual([
      "Running2.0.3",
      "OrganizationTrack latest 2.0.3",
      "UpdateUp to date",
    ]);
    expect(within(updateCell()).getByText("Up to date")).toBeTruthy();
    // A version is metadata: a badge (Design rules 1 and 2), the running one and the
    // organization's.
    for (const cell of ["Running", "Organization"]) {
      const version = within(screen.getByRole("group", { name: cell, hidden: true })).getByText(
        "2.0.3",
      );
      expect(version.classList.contains("or-mono")).toBe(true);
      expect(version.closest("[data-or-badge]")).not.toBeNull();
    }
    expect(disabled(updateNow())).toBe(false);
    expect(screen.queryByText(NOT_UNDER_PM2)).toBeNull();
    expect(screen.queryByRole("region", { name: "Failed versions" })).toBeNull();
    const card = screen.getByRole("region", { name: "Pin a version" });
    expect(within(card).getByText(PIN_DESCRIPTION)).toBeTruthy();
    expect(PIN_DESCRIPTION).toBe("A pinned version wins over the organization's policy.");
    const pin = within(card).getByRole("switch", { name: "Pin this agent's version" });
    expect(pin.getAttribute("aria-checked")).toBe("false");
    const version = within(card).getByLabelText("Version") as HTMLInputElement;
    expect(version.disabled).toBe(true);
    expect(version.classList.contains("or-input--mono")).toBe(true);
  });

  it("never says Up to date while it runs another version than it should, and says why", async () => {
    // The next heartbeat starts the update.
    await openVersion();
    expect(summary()[2]).toBe("UpdateUpdating to 2.0.4 soon");
    expect(within(updateCell()).getByText("2.0.4").closest("[data-or-badge]")).not.toBeNull();
    expect(within(updateCell()).getByText("soon")).toBeTruthy();
  });

  it("says the agent's pin is why it doesn't follow the organization's version", async () => {
    await openVersion({ settings: settingsState({ v: 1, update: { pin: "2.0.3" } }) });
    expect(summary().slice(1)).toEqual(["OrganizationTrack latest 2.0.4", "UpdatePinned to 2.0.3"]);
    // The version the Update cell names is a badge too, like its peers' (Design rule 1).
    const version = within(updateCell()).getByText("2.0.3");
    expect(version.closest("[data-or-badge]")).not.toBeNull();
    expect(within(updateCell()).getByText("Pinned to")).toBeTruthy();
  });

  it("says it isn't retrying a version that failed", async () => {
    await openVersion({ update: updateState({ failedVersions: ["2.0.4"] }) });
    expect(summary()[2]).toBe("UpdateNot retrying 2.0.4");
  });

  it("says it can't update itself when not under pm2 and behind the organization", async () => {
    await openVersion({ update: updateState({ selfUpdate: "unsupported" }) });
    expect(summary()[2]).toBe("UpdateCan't update itself");
  });

  it("says Pinned to for an organization that pins one version", async () => {
    await openVersion({ versionPolicy: { kind: "pinned", version: "2.0.3" } });
    expect(summary()[1]).toBe("OrganizationPinned to 2.0.3");
  });

  it("shows Finishing running work while draining, and refuses another Update now", async () => {
    await openVersion({ update: updateState({ state: "draining", version: "2.0.4" }) });
    expect(summary()[2]).toBe("UpdateFinishing running work");
    expect(disabled(updateNow())).toBe(true);
  });

  it("shows Installing <version> while installing", async () => {
    await openVersion({ update: updateState({ state: "installing", version: "2.0.4" }) });
    expect(summary()[2]).toBe("UpdateInstalling 2.0.4");
    expect(disabled(updateNow())).toBe(true);
  });

  it("shows Checking <version> while confirming a new version", async () => {
    await openVersion({ update: updateState({ state: "confirming", version: "2.0.4" }) });
    expect(summary()[2]).toBe("UpdateChecking 2.0.4");
  });

  it("lists failed versions in the fail tone with the last error (failed)", async () => {
    await openVersion({
      update: updateState({
        failedVersions: ["2.0.4", "2.0.5"],
        error: "Installing 2.0.5 failed: npm error 404",
      }),
    });
    expect(within(updateCell()).getByText("The last update failed").className).toContain(
      "or-status--fail",
    );
    const failed = screen.getByRole("region", { name: "Failed versions" });
    const badges = within(failed).getAllByRole("listitem");
    expect(badges.map((badge) => badge.textContent)).toEqual(["2.0.4", "2.0.5"]);
    for (const badge of badges) {
      expect(badge.querySelector(".agent-badge--fail")).not.toBeNull();
    }
    const error = within(failed).getByText("Installing 2.0.5 failed: npm error 404");
    expect(error.className).toContain("or-status--fail");
    // Update now still tries again.
    expect(disabled(updateNow())).toBe(false);
  });

  it("says it can't update itself and disables Update now when not under pm2 (unsupported)", async () => {
    await openVersion({ update: updateState({ selfUpdate: "unsupported" }) });
    expect(screen.getByText(NOT_UNDER_PM2)).toBeTruthy();
    expect(NOT_UNDER_PM2).toBe(
      "This agent can't update itself because it isn't running under pm2.",
    );
    expect(disabled(updateNow())).toBe(true);
  });

  it("confirms Update now, shows Finishing running work at once, then each state from update events", async () => {
    const answer = deferred<{ status: number; body: unknown }>();
    let posted = 0;
    const { api, streams, machine } = await openVersion({
      settings: settingsState({ v: 1, update: { pin: "2.0.5" } }, { revision: REVISION }),
      routes: () => ({
        "POST /api/update": () => {
          posted += 1;
          return answer.promise;
        },
      }),
    });
    streams.latest().open();

    await userEvent.click(updateNow());
    const dialog = await screen.findByRole("alertdialog", { name: "Update now?" });
    expect(
      within(dialog).getByText(
        "Update now? The agent stops taking new work, finishes what's running, installs 2.0.5 and restarts.",
      ),
    ).toBeTruthy();
    expect(posted).toBe(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Update now" }));

    // Before the agent answered.
    await waitFor(() => expect(summary()[2]).toBe("UpdateFinishing running work"));
    expect(posted).toBe(1);
    expect(disabled(updateNow())).toBe(true);

    const request = { version: null, requestedAt: "2026-10-28T10:50:00.000Z" };
    machine.update = updateState({ request });
    answer.resolve({ status: 202, body: { request } });
    await waitFor(() => expect(api.count("GET /api/state")).toBeGreaterThan(1));
    expect(summary()[2]).toBe("UpdateFinishing running work");

    // The heartbeat started the drain, then the install: `update` events, no reload.
    machine.update = updateState({ state: "draining", version: "2.0.5" });
    streams.latest().change({ resource: "update" });
    await waitFor(() => expect(summary()[2]).toBe("UpdateFinishing running work"));
    machine.update = updateState({ state: "installing", version: "2.0.5" });
    streams.latest().change({ resource: "update" });
    await waitFor(() => expect(summary()[2]).toBe("UpdateInstalling 2.0.5"));
  });

  it("names the organization's version, else the latest, in the confirmation", async () => {
    await openVersion({ versionPolicy: null });
    await userEvent.click(updateNow());
    const dialog = await screen.findByRole("alertdialog", { name: "Update now?" });
    expect(within(dialog).getByText(/installs the latest version and restarts\.$/)).toBeTruthy();
  });

  it("refuses a pin below 2.0.0, and saves a pin through the staged card", async () => {
    let sent: unknown;
    await openVersion({
      routes: (machine) => ({
        "PUT /api/settings/version": (init) => {
          sent = JSON.parse(String(init?.body));
          machine.settings = settingsState(
            { v: 1, update: { pin: "2.0.3" } },
            { revision: NEXT_REVISION },
          );
          return { body: machine.settings };
        },
      }),
    });
    const card = screen.getByRole("region", { name: "Pin a version" });
    await userEvent.click(within(card).getByRole("switch", { name: "Pin this agent's version" }));
    const version = within(card).getByLabelText("Version");
    await userEvent.type(version, "1.9.0");
    expect(within(card).getByText(PIN_TOO_OLD)).toBeTruthy();
    expect(PIN_TOO_OLD).toBe("Use 2.0.0 or later");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sent).toBeUndefined();

    await userEvent.clear(version);
    await userEvent.type(version, "2.0.3");
    expect(within(card).queryByText(PIN_TOO_OLD)).toBeNull();
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    expect(bar.querySelector(".or-pending__label")?.textContent).toBe("Pinned version");
    expect(bar.querySelector(".or-pending__to")?.textContent).toBe("2.0.3");
    await userEvent.click(within(bar).getByRole("button", { name: "Save" }));
    expect(sent).toEqual({ revision: REVISION, pin: "2.0.3" });
    // The toast; the summary says it too.
    await screen.findByText("Pinned to 2.0.3", { selector: ".or-toast__message" });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull(),
    );
    expect(
      within(card)
        .getByRole("switch", { name: "Pin this agent's version" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // The confirmation now names the pin.
    await userEvent.click(updateNow());
    const dialog = await screen.findByRole("alertdialog", { name: "Update now?" });
    expect(within(dialog).getByText(/installs 2\.0\.3 and restarts\.$/)).toBeTruthy();
  });

  it("shows a saved pin at once, before the state refetch answers", async () => {
    const refetch = deferred<{ body: unknown }>();
    let gets = 0;
    const saved = settingsState({ v: 1, update: { pin: "2.0.3" } }, { revision: NEXT_REVISION });
    const { api } = await openVersion({
      routes: (machine) => ({
        "/api/state": () => (++gets === 1 ? { body: agentState(machine) } : refetch.promise),
        "PUT /api/settings/version": () => ({ body: saved }),
      }),
    });
    const card = screen.getByRole("region", { name: "Pin a version" });
    await userEvent.click(within(card).getByRole("switch", { name: "Pin this agent's version" }));
    await userEvent.type(within(card).getByLabelText("Version"), "2.0.3");
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    await userEvent.click(within(bar).getByRole("button", { name: "Save" }));

    // The toast; the summary says it too.
    await screen.findByText("Pinned to 2.0.3", { selector: ".or-toast__message" });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull(),
    );
    expect(
      within(card)
        .getByRole("switch", { name: "Pin this agent's version" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect((within(card).getByLabelText("Version") as HTMLInputElement).value).toBe("2.0.3");
    await userEvent.click(updateNow());
    const dialog = await screen.findByRole("alertdialog", { name: "Update now?" });
    expect(within(dialog).getByText(/installs 2\.0\.3 and restarts\.$/)).toBeTruthy();
    // The page asked for the state again, and that refetch hasn't answered yet.
    expect(api.count("GET /api/state")).toBeGreaterThanOrEqual(2);
    refetch.resolve({ body: agentState({ settings: saved }) });
  });

  it("unpins, and keeps the edit when settings.json changed on the machine", async () => {
    const latest = settingsState(
      { v: 1, maxConcurrency: 3, update: { pin: "2.0.3" } },
      { revision: NEXT_REVISION },
    );
    await openVersion({
      settings: settingsState({ v: 1, update: { pin: "2.0.3" } }, { revision: REVISION }),
      routes: (machine) => ({
        "PUT /api/settings/version": () => {
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
    const card = screen.getByRole("region", { name: "Pin a version" });
    await userEvent.click(within(card).getByRole("switch", { name: "Pin this agent's version" }));
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    expect(bar.querySelector(".or-pending__to")?.textContent).toBe("None");
    await userEvent.click(within(bar).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Unsaved changes" })).getByText(
          "These settings changed on the machine. Review and save again.",
        ),
      ).toBeTruthy(),
    );
    expect(
      within(card)
        .getByRole("switch", { name: "Pin this agent's version" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("opens full screen with a back link at narrow widths, its fields in one column", async () => {
    await openVersion({ width: NARROW, update: updateState({ failedVersions: ["2.0.4"] }) });
    expect(document.querySelector(".or-split")?.getAttribute("data-view")).toBe("detail");
    expect(screen.getByRole("link", { name: "Agent" })).toBeTruthy();
    expect(summary()).toHaveLength(3);
    expect(screen.getByRole("region", { name: "Failed versions" })).toBeTruthy();
    // `Field`'s own rule: one column below 769 px; the summary cells wrap.
    const require = createRequire(import.meta.url);
    const dir = path.dirname(require.resolve("@omniralph/ui/styles.css"));
    const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
    const fields = strip(readFileSync(path.join(dir, "fields.css"), "utf8"));
    expect(fields).toMatch(/@media\s*\(max-width:\s*768px\)/);
    // The badges wrap rather than overflow.
    const own = strip(readFileSync(path.join(__dirname, "../../styles.css"), "utf8"));
    expect(own).toMatch(/\.agent-badges\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});
