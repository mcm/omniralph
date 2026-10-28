// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  NARROW,
  WIDE,
  agentState,
  fakeApi,
  fakeEventSources,
  renderAgentPage,
  settingsState,
} from "../../test/page.js";
import { SETTINGS_CHANGED } from "./capacity-page.js";

const REVISION = "a".repeat(64);
const NEXT_REVISION = "b".repeat(64);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function input(label: string): HTMLInputElement {
  return screen.getByLabelText(label, { selector: "input" });
}

function kind(label: string): HTMLInputElement {
  const group = screen.getByRole("group", { name: "Kinds" });
  return within(group).getByRole("checkbox", { name: label });
}

async function replace(label: string, value: string) {
  await userEvent.clear(input(label));
  if (value !== "") await userEvent.type(input(label), value);
}

function saveBar(): HTMLElement {
  return screen.getByRole("region", { name: "Unsaved changes" });
}

async function openCapacity({
  settings = settingsState({ v: 1 }, { revision: REVISION }),
  width = WIDE,
  routes = {},
}: {
  settings?: ReturnType<typeof settingsState>;
  width?: number;
  routes?: Parameters<typeof fakeApi>[0];
} = {}) {
  const api = fakeApi({ "/api/state": { body: agentState({ settings }) }, ...routes });
  const streams = fakeEventSources();
  renderAgentPage({ path: "/capacity", width, createEventSource: streams.create });
  await screen.findByLabelText("Slots", { selector: "input" });
  return { api, streams };
}

describe("the Capacity page", () => {
  it("shows one card with Slots, Coding slots, Review and ask slots and Kinds", async () => {
    await openCapacity();
    expect(screen.getByRole("heading", { level: 2, name: "Capacity" })).toBeTruthy();
    const card = screen.getByRole("region", { name: "Slots and kinds" });
    for (const text of [
      "How many attempts this agent runs at the same time.",
      "Coding attempts can take hours. By default one slot stays free for reviews and asks.",
      "Reviews, asks and triage.",
      "Only work of these kinds is offered to this agent.",
    ]) {
      expect(within(card).getByText(text)).toBeTruthy();
    }
    expect(input("Slots").value).toBe("");
    // Blank fields show their defaults.
    expect(input("Slots").placeholder).toBe("Default: 5");
    expect(input("Coding slots").placeholder).toBe("Default: 4");
    expect(input("Review and ask slots").placeholder).toBe("Default: 5");
    expect(["Review", "Coding", "Ask"].map((label) => kind(label).checked)).toEqual([
      true,
      true,
      true,
    ]);
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the saved values, and pool defaults that follow the drafted Slots", async () => {
    await openCapacity({
      settings: settingsState(
        { v: 1, maxConcurrency: 3, poolLimits: { short: 2 }, acceptedTaskTypes: ["coding"] },
        { revision: REVISION },
      ),
    });
    expect(input("Slots").value).toBe("3");
    expect(input("Coding slots").value).toBe("");
    expect(input("Coding slots").placeholder).toBe("Default: 2");
    expect(input("Review and ask slots").value).toBe("2");
    expect(["Review", "Coding", "Ask"].map((label) => kind(label).checked)).toEqual([
      false,
      true,
      false,
    ]);
    await replace("Slots", "8");
    expect(input("Coding slots").placeholder).toBe("Default: 7");
  });

  it("says a pool can't be more than Slots, on the field", async () => {
    await openCapacity();
    await replace("Slots", "3");
    await replace("Coding slots", "4");
    const coding = input("Coding slots");
    expect(coding.getAttribute("aria-invalid")).toBe("true");
    const error = document.getElementById(
      coding.getAttribute("aria-describedby")!.split(" ").at(-1)!,
    );
    expect(error?.textContent).toBe("Can't be more than Slots");
    expect(input("Review and ask slots").getAttribute("aria-invalid")).toBeNull();
    // Saving is refused until it's fixed.
    await userEvent.click(within(saveBar()).getByRole("button", { name: "Save" }));
    expect(within(saveBar()).getByRole("alert").textContent).toBe(
      "Some values can't be saved yet.",
    );
    await replace("Coding slots", "3");
    expect(coding.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText("Can't be more than Slots")).toBeNull();
  });

  it("checks Slots is a number from 1 to 32", async () => {
    await openCapacity();
    await replace("Slots", "33");
    expect(screen.getByText("Enter a number from 1 to 32")).toBeTruthy();
    await replace("Slots", "two");
    expect(screen.getByText("Enter a number from 1 to 32")).toBeTruthy();
    await replace("Slots", "2");
    expect(screen.queryByText("Enter a number from 1 to 32")).toBeNull();
  });

  it("keeps at least one kind checked", async () => {
    await openCapacity({
      settings: settingsState({ v: 1, acceptedTaskTypes: ["review", "coding"] }),
    });
    await userEvent.click(kind("Coding"));
    expect(kind("Coding").checked).toBe(false);
    await userEvent.click(kind("Review"));
    expect(kind("Review").checked).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("Keep at least one kind");
    const items = within(saveBar()).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]!.querySelector(".or-pending__label")?.textContent).toBe("Coding work");
    await userEvent.click(kind("Ask"));
    expect(screen.queryByText("Keep at least one kind")).toBeNull();
  });

  it("lists each change with its effect in the save bar", async () => {
    await openCapacity({ settings: settingsState({ v: 1, maxConcurrency: 5 }) });
    await replace("Slots", "3");
    await replace("Coding slots", "1");
    await replace("Review and ask slots", "3");
    await userEvent.click(kind("Ask"));
    const items = within(saveBar()).getAllByRole("listitem");
    const item = (index: number) => ({
      label: items[index]!.querySelector(".or-pending__label")?.textContent,
      from: items[index]!.querySelector(".or-pending__from")?.textContent,
      to: items[index]!.querySelector(".or-pending__to")?.textContent,
      effect: items[index]!.querySelector(".or-pending__effect")?.textContent,
    });
    expect(items.map((_, index) => item(index))).toEqual([
      {
        label: "Slots",
        from: "5",
        to: "3",
        effect: "No new work starts until fewer than 3 are running.",
      },
      {
        label: "Coding slots",
        from: "4",
        to: "1",
        effect: "No new coding attempt starts until fewer than 1 are running.",
      },
      {
        label: "Review and ask slots",
        from: "5",
        to: "3",
        effect: "No new review, ask or triage starts until fewer than 3 are running.",
      },
      {
        label: "Ask work",
        from: "On",
        to: "Off",
        effect: "Ask work is no longer offered to this agent. Running attempts finish.",
      },
    ]);
    expect(within(saveBar()).getByText("4 unsaved changes")).toBeTruthy();

    await replace("Slots", "8");
    await replace("Coding slots", "");
    expect(item(0)).toEqual({
      label: "Slots",
      from: "5",
      to: "8",
      effect: "Up to 8 attempts run at the same time.",
    });
    expect(screen.queryByText("Coding slots", { selector: ".or-pending__label" })).toBeNull();
  });

  it("shows the saved values at once, before any refetch", async () => {
    const saved = settingsState(
      { v: 1, maxConcurrency: 3, acceptedTaskTypes: ["review", "coding"] },
      { revision: NEXT_REVISION },
    );
    const bodies: unknown[] = [];
    let gets = 0;
    const refetch = deferred<{ body: unknown }>();
    const { api } = await openCapacity({
      routes: {
        "/api/state": () =>
          ++gets === 1
            ? { body: agentState({ settings: settingsState({ v: 1 }, { revision: REVISION }) }) }
            : refetch.promise,
        "PUT /api/settings/capacity": (init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return {
            body: settingsState({ v: 1, maxConcurrency: 3 }, { revision: "c".repeat(64) }),
          };
        },
        "PUT /api/settings/kinds": (init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return { body: saved };
        },
      },
    });
    await replace("Slots", "3");
    await userEvent.click(kind("Ask"));
    await userEvent.click(within(saveBar()).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull(),
    );
    expect(input("Slots").value).toBe("3");
    expect(input("Coding slots").placeholder).toBe("Default: 2");
    expect(kind("Ask").checked).toBe(false);
    expect(await screen.findByText("Capacity saved")).toBeTruthy();
    expect(bodies).toEqual([
      { revision: REVISION, maxConcurrency: 3, poolLimits: { long: null, short: null } },
      { revision: "c".repeat(64), acceptedTaskTypes: ["review", "coding"] },
    ]);
    // The page asked for the state again, and that refetch hasn't answered yet.
    expect(api.count("GET /api/state")).toBeGreaterThanOrEqual(2);
    refetch.resolve({ body: agentState({ settings: saved }) });
  });

  it("sends every kind as the default and blank fields as null", async () => {
    const bodies: unknown[] = [];
    await openCapacity({
      settings: settingsState(
        { v: 1, maxConcurrency: 4, poolLimits: { long: 2 }, acceptedTaskTypes: ["review"] },
        { revision: REVISION },
      ),
      routes: {
        "PUT /api/settings/capacity": (init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return { body: settingsState({ v: 1, acceptedTaskTypes: ["review"] }) };
        },
        "PUT /api/settings/kinds": (init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return { body: settingsState({ v: 1 }) };
        },
      },
    });
    await replace("Slots", "");
    await replace("Coding slots", "");
    await userEvent.click(kind("Coding"));
    await userEvent.click(kind("Ask"));
    await userEvent.click(within(saveBar()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies).toEqual([
      { revision: REVISION, maxConcurrency: null, poolLimits: { long: null, short: null } },
      { revision: "none" },
    ]);
  });

  it("reloads the card with the current values after a 409 and asks to review and save again", async () => {
    const current = settingsState(
      { v: 1, maxConcurrency: 8, poolLimits: { short: 2 } },
      { revision: NEXT_REVISION },
    );
    let puts = 0;
    const bodies: unknown[] = [];
    await openCapacity({
      routes: {
        // The machine's file changed: refetches answer it.
        "/api/state": () => ({
          body: agentState({
            settings: puts === 0 ? settingsState({ v: 1 }, { revision: REVISION }) : current,
          }),
        }),
        "PUT /api/settings/capacity": (init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return ++puts === 1
            ? { status: 409, body: { error: SETTINGS_CHANGED, settings: current } }
            : { body: settingsState({ ...current.settings, maxConcurrency: 6 }) };
        },
      },
    });
    await replace("Slots", "6");
    await userEvent.click(within(saveBar()).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(input("Review and ask slots").value).toBe("2"));
    expect(input("Slots").value).toBe("6");
    expect(within(saveBar()).getByRole("alert").textContent).toBe(SETTINGS_CHANGED);
    expect(
      within(saveBar())
        .getByText("Slots", { selector: ".or-pending__label" })
        .parentElement?.querySelector(".or-pending__from")?.textContent,
    ).toBe("8");

    // Saving again goes against the current revision.
    await userEvent.click(within(saveBar()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ revision: NEXT_REVISION, maxConcurrency: 6 });
  });

  it("shows the agent's field errors where they belong", async () => {
    await openCapacity({
      routes: {
        "PUT /api/settings/capacity": {
          status: 400,
          body: {
            error: "These settings aren't valid.",
            issues: [
              { path: ["poolLimits", "short"], message: "must be at most maxConcurrency (2)" },
            ],
          },
        },
      },
    });
    await replace("Review and ask slots", "2");
    await userEvent.click(within(saveBar()).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("must be at most maxConcurrency (2)")).toBeTruthy();
    expect(input("Review and ask slots").getAttribute("aria-invalid")).toBe("true");
    expect(within(saveBar()).getByRole("alert").textContent).toBe("These settings aren't valid.");
  });

  it("updates untouched fields from a hand edit's settings event and keeps edited ones", async () => {
    let settings = settingsState({ v: 1 }, { revision: REVISION });
    const { streams } = await openCapacity({
      routes: { "/api/state": () => ({ body: agentState({ settings }) }) },
    });
    streams.latest().open();
    await replace("Slots", "6");

    settings = settingsState(
      { v: 1, maxConcurrency: 4, poolLimits: { short: 3 }, acceptedTaskTypes: ["review"] },
      { revision: NEXT_REVISION },
    );
    streams.latest().change({ resource: "settings" });

    await waitFor(() => expect(input("Review and ask slots").value).toBe("3"));
    expect(input("Slots").value).toBe("6");
    expect(kind("Coding").checked).toBe(false);
    expect(
      within(saveBar())
        .getAllByRole("listitem")
        .map((item) => item.querySelector(".or-pending__label")?.textContent),
    ).toEqual(["Slots"]);
    expect(within(saveBar()).getByText("4", { selector: ".or-pending__from" })).toBeTruthy();
  });

  it("shows an invalid hand edit of settings.json as an alert", async () => {
    let settings = settingsState({ v: 1 }, { revision: REVISION });
    const { streams } = await openCapacity({
      routes: { "/api/state": () => ({ body: agentState({ settings }) }) },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    streams.latest().open();
    settings = settingsState({ v: 1 }, { revision: REVISION, lastError: "it isn't valid JSON" });
    streams.latest().change({ resource: "settings" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "settings.json isn't valid: it isn't valid JSON; the agent keeps its last good settings",
    );
  });

  it("stacks every field in one column at narrow widths", async () => {
    await openCapacity({ width: NARROW });
    expect(document.querySelector(".or-split")?.getAttribute("data-view")).toBe("detail");
    const card = screen.getByRole("region", { name: "Slots and kinds" });
    const fields = card.querySelectorAll(".or-field");
    expect(fields).toHaveLength(4);
    for (const field of fields) expect(field.classList.contains("or-field--stacked")).toBe(false);
    // `Field`'s own rule puts the label above the control at 768 px and narrower.
    const require = createRequire(import.meta.url);
    const css = readFileSync(
      path.join(path.dirname(require.resolve("@omniralph/ui/styles.css")), "fields.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const narrow = /@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(narrow).toMatch(/\.or-field\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
});
