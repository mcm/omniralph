// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { StorageItemKey, StoredRepo } from "../../../../src/storage.js";
import type { StorageState } from "../../../../src/ui/machine-routes.js";
import {
  NARROW,
  WIDE,
  agentState,
  fakeApi,
  fakeEventSources,
  renderAgentPage,
} from "../../test/page.js";
import { NO_REPOS } from "./model.js";

const GB = 1_000_000_000;
const WORKSPACE = "/home/ci/.omniralph/repos";
const DATA = "/home/ci/.omniralph";
const MINUTES_AGO = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const ITEM_PATHS: Record<StorageItemKey, string[]> = {
  repo_cache: [WORKSPACE],
  worktrees: [`${WORKSPACE}/.worktrees`],
  branch_worktrees: [`${WORKSPACE}/.branches`],
  packages: [`${DATA}/installables`],
  caches: [`${DATA}/cache`, `${DATA}/pr-cache`],
  logs: [`${DATA}/logs`],
};

function storageState(
  overrides: { sizes?: Partial<Record<StorageItemKey, number>> } & Partial<StorageState> = {},
): StorageState {
  const { sizes = {}, ...rest } = overrides;
  return {
    items: (Object.keys(ITEM_PATHS) as StorageItemKey[]).map((key) => ({
      key,
      paths: ITEM_PATHS[key],
      bytes: sizes[key] ?? 1_000_000,
    })),
    measuredAt: MINUTES_AGO(3),
    filesystems: [
      { paths: [WORKSPACE, DATA], freeBytes: 120 * GB, totalBytes: 500 * GB, low: false },
    ],
    low: false,
    roots: { workspaceRoot: WORKSPACE, dataDir: DATA },
    measuring: false,
    ...rest,
  };
}

function repo(overrides: Partial<StoredRepo> = {}): StoredRepo {
  return {
    provider: "github",
    host: "github.com",
    fullPath: "acme/customer-portal",
    path: `${WORKSPACE}/github/github.com/acme/customer-portal`,
    bytes: 2_400_000_000,
    lastFetchedAt: MINUTES_AGO(12),
    lastSync: { outcome: "completed", error: null, at: MINUTES_AGO(10) },
    pinned: false,
    ...overrides,
  };
}

/** What the daemon answers now: a refetch reads it. */
interface Machine {
  storage: StorageState;
  repos: StoredRepo[];
}

async function openStorage({
  storage = storageState(),
  repos = [repo()],
  width = WIDE,
  routes = () => ({}),
}: {
  storage?: StorageState;
  repos?: StoredRepo[];
  width?: number;
  routes?: (machine: Machine) => Parameters<typeof fakeApi>[0];
} = {}) {
  const machine: Machine = { storage, repos };
  const api = fakeApi({
    "/api/state": () => ({ body: agentState() }),
    "/api/storage": () => ({ body: machine.storage }),
    "/api/repos": () => ({ body: { repos: machine.repos } }),
    ...routes(machine),
  });
  const streams = fakeEventSources();
  renderAgentPage({ path: "/storage", width, createEventSource: streams.create });
  await screen.findByRole("heading", { level: 2, name: "Storage", hidden: true });
  await screen.findByRole("region", { name: "Usage" });
  return { api, streams, machine };
}

function freeSpaceCells(): string[] {
  const cells = screen.getByRole("region", { name: "Free space" });
  return within(cells)
    .getAllByRole("group")
    .map((cell) => cell.textContent ?? "");
}

function usageTable(): HTMLElement {
  return within(screen.getByRole("region", { name: "Usage" })).getByRole("table");
}

function reposCard(): HTMLElement {
  return screen.getByRole("region", { name: "Repos" });
}

/** A table's body rows as cell texts. */
function rows(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent ?? ""),
    );
}

function measureAgain(): HTMLButtonElement {
  return within(screen.getByRole("region", { name: "Usage" })).getByRole("button", {
    name: /Measure again|Measuring/,
  }) as HTMLButtonElement;
}

describe("the Storage page", () => {
  it("shows free space per filesystem, what the agent stores and the cached repos", async () => {
    await openStorage({
      storage: storageState({
        sizes: { repo_cache: 12_300_000_000, worktrees: 4_200_000_000, logs: 512_000 },
      }),
    });
    expect(freeSpaceCells()).toEqual(["Workspace and data120 GB freeof 500 GB"]);
    expect(document.querySelector(".or-stats .or-status--fail")).toBeNull();

    expect(rows(usageTable())).toEqual([
      ["Repo cache", WORKSPACE, "12 GB"],
      ["Worktrees", `${WORKSPACE}/.worktrees`, "4.2 GB"],
      ["Branch worktrees", `${WORKSPACE}/.branches`, "1 MB"],
      ["Packages", `${DATA}/installables`, "1 MB"],
      ["Caches", `${DATA}/cache${DATA}/pr-cache`, "1 MB"],
      ["Logs", `${DATA}/logs`, "512 KB"],
    ]);
    const pathCell = within(usageTable()).getByText(`${DATA}/logs`).closest("td");
    expect(pathCell?.className).toMatch(/mono/);
    expect(
      within(screen.getByRole("region", { name: "Usage" })).getByText("3 minutes ago"),
    ).toBeTruthy();
    expect(measureAgain().disabled).toBe(false);

    const table = within(reposCard()).getByRole("table");
    expect(rows(table)).toEqual([
      [
        "GitHub acme/customer-portal",
        "2.4 GB",
        "12 minutes ago",
        "Synced customer-portal 10 minutes ago",
      ],
    ]);
    expect(within(table).getByText("acme/customer-portal").closest(".or-ref")).not.toBeNull();
    expect(within(table).queryByText("Pinned")).toBeNull();
  });

  it("names separate filesystems and says low ones in the fail tone", async () => {
    await openStorage({
      storage: storageState({
        filesystems: [
          { paths: [WORKSPACE], freeBytes: 3 * GB, totalBytes: 500 * GB, low: true },
          { paths: [DATA], freeBytes: 40 * GB, totalBytes: 100 * GB, low: false },
        ],
        low: true,
      }),
    });
    expect(freeSpaceCells()).toEqual(["Workspace3 GB freeof 500 GB", "Data40 GB freeof 100 GB"]);
    const workspace = screen.getByRole("group", { name: "Workspace" });
    expect(within(workspace).getByText("3 GB free").closest(".or-status--fail")).not.toBeNull();
    const data = screen.getByRole("group", { name: "Data" });
    expect(data.querySelector(".or-status--fail")).toBeNull();
  });

  it("marks pinned repos, never-fetched ones, and failed syncs in the fail tone", async () => {
    await openStorage({
      repos: [
        repo({
          fullPath: "acme/billing",
          path: `${WORKSPACE}/github/github.com/acme/billing`,
          lastFetchedAt: null,
          lastSync: null,
          pinned: true,
        }),
        repo({
          provider: "gitlab",
          host: "gitlab.com",
          fullPath: "acme/infra/deploy",
          path: `${WORKSPACE}/gitlab/gitlab.com/acme/infra/deploy`,
          lastSync: {
            outcome: "failed",
            error: "fatal: could not read from remote",
            at: MINUTES_AGO(1),
          },
        }),
      ],
    });
    const table = within(reposCard()).getByRole("table");
    expect(rows(table)).toEqual([
      ["GitHub acme/billingPinned", "2.4 GB", "Never", "No sync recorded"],
      [
        "GitLab acme/infra/deploy",
        "2.4 GB",
        "12 minutes ago",
        "Couldn't sync deploy: fatal: could not read from remote",
      ],
    ]);
    const failed = within(table).getByText(
      "Couldn't sync deploy: fatal: could not read from remote",
    );
    expect(failed.closest(".or-status--fail")).not.toBeNull();
    expect(failed.closest("tr")?.className).toMatch(/bad/);
    expect(within(table).getByText("Pinned").closest("tr")?.className ?? "").not.toMatch(/bad/);
  });

  it("says No repos cached yet for an empty cache", async () => {
    await openStorage({ repos: [] });
    await within(reposCard()).findByText(NO_REPOS);
    expect(NO_REPOS).toBe("No repos cached yet");
    expect(within(reposCard()).queryByRole("table")).toBeNull();
  });

  it("Measure again says Measuring at once, and the storage event brings the new sizes", async () => {
    const { api, streams, machine } = await openStorage({
      routes: (m) => ({
        "POST /api/storage/measure": () => {
          // The daemon starts a walk: a refetch now says so.
          m.storage = { ...m.storage, measuring: true };
          return { status: 202, body: { measuring: true } };
        },
      }),
    });
    streams.latest().open();
    await userEvent.click(measureAgain());
    await waitFor(() => expect(measureAgain().disabled).toBe(true));
    expect(measureAgain().textContent).toBe("Measuring…");
    expect(api.count("POST /api/storage/measure")).toBe(1);

    machine.storage = storageState({
      sizes: { logs: 9_000_000 },
      measuredAt: new Date().toISOString(),
      measuring: false,
    });
    machine.repos = [repo({ bytes: 3_100_000_000 })];
    streams.latest().change({ resource: "storage" });
    streams.latest().change({ resource: "repos" });
    await within(usageTable()).findByText("9 MB");
    await waitFor(() => expect(measureAgain().disabled).toBe(false));
    expect(measureAgain().textContent).toBe("Measure again");
    expect(
      within(screen.getByRole("region", { name: "Usage" })).getByText("just now"),
    ).toBeTruthy();
    await within(within(reposCard()).getByRole("table")).findByText("3.1 GB");
  });

  it("shows Measuring before the agent answers", async () => {
    let answer!: (reply: { status: number; body: unknown }) => void;
    await openStorage({
      routes: () => ({
        "POST /api/storage/measure": () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      }),
    });
    await userEvent.click(measureAgain());
    expect(measureAgain().disabled).toBe(true);
    answer({ status: 202, body: { measuring: true } });
  });

  it("a recorded repo sync updates the Repos table from its event", async () => {
    const { streams, machine } = await openStorage({ repos: [repo({ lastSync: null })] });
    streams.latest().open();
    const table = () => within(reposCard()).getByRole("table");
    expect(within(table()).getByText("No sync recorded")).toBeTruthy();
    machine.repos = [
      repo({ lastSync: { outcome: "completed", error: null, at: new Date().toISOString() } }),
    ];
    streams.latest().change({ resource: "repos" });
    await within(table()).findByText("Synced customer-portal just now");
  });

  it("opens full screen with a back link at narrow widths, tables as cards", async () => {
    await openStorage({ width: NARROW });
    expect(document.querySelector(".or-split")?.getAttribute("data-view")).toBe("detail");
    expect(screen.getByRole("link", { name: "Agent" })).toBeTruthy();
    for (const name of ["Usage", "Repos"]) {
      const cards = screen.getByRole("list", { name });
      expect(cards.classList.contains("or-cards")).toBe(true);
    }
    expect(
      within(screen.getByRole("list", { name: "Repos" })).getByText("acme/customer-portal"),
    ).toBeTruthy();
    const require = createRequire(import.meta.url);
    const dir = path.dirname(require.resolve("@omniralph/ui/styles.css"));
    const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
    // `DataTable`'s own rule: the table hides and the cards show at 768 px and narrower.
    const lists = strip(readFileSync(path.join(dir, "lists.css"), "utf8"));
    const narrow = /@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/.exec(lists)?.[1] ?? "";
    expect(narrow).toMatch(/\.or-tblwrap\s*\{[^}]*display:\s*none/);
    expect(narrow).toMatch(/\.or-cards\s*\{[^}]*display:\s*flex/);
  });
});
