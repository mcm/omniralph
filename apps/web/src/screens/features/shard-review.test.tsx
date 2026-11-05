// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  TEST_ORGANIZATION_ID,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import type {
  FeatureShardDraftRow,
  FeatureShardRow,
  FeatureShardView,
} from "@/lib/api/feature-shards";
import type { FeatureRow } from "@/lib/api/features";
import {
  DISCARD_ACTION,
  FILE_ACTION,
  LEFTOVERS_TITLE,
  MAPPING_OMNIRALPH,
  MAPPING_PARENT_ISSUE,
  NO_SHARD,
  SHARD_ACTION,
  ShardPanel,
  UNDECIDED_HINT,
} from "./shard-review";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const FEATURE_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const REPO_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const OTHER_REPO_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
const SHARD_PATH = `/api/ui/features/${FEATURE_ID}/shard`;

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ id: TEST_ORGANIZATION_ID, name: "Acme", role: "member" }],
};

const feature: FeatureRow = {
  id: FEATURE_ID,
  name: "Invoicing",
  status: "planning",
  repository: { id: REPO_ID, provider: "github", fullPath: "acme/portal" },
  epicCount: 0,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
};

function draftRow(
  key: string,
  overrides: Partial<FeatureShardDraftRow> = {},
): FeatureShardDraftRow {
  return {
    key,
    title: `Epic ${key}`,
    description: `## Problem\n\nPeople need epic ${key}.`,
    covers: [],
    dependsOn: [],
    notes: [],
    decision: "pending",
    edited: false,
    filed: null,
    ...overrides,
  };
}

function shardRow(overrides: Partial<FeatureShardRow> = {}): FeatureShardRow {
  return {
    id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
    status: "review",
    planVersion: 2,
    sections: [
      { name: "Storage", body: "Store invoices in Postgres." },
      { name: "Export", body: "Export invoices as CSV." },
    ],
    drafts: [
      draftRow("E1", { covers: ["Storage"], notes: ["Builds the storage."] }),
      draftRow("E2", { covers: ["Export"], dependsOn: ["E1"] }),
    ],
    exempt: [],
    summary: "Two epics, storage first.",
    leftovers: [],
    error: null,
    rounds: [
      { number: 1, status: "done", passed: false, summary: "The export is missing." },
      { number: 2, status: "done", passed: true, summary: "Every section is covered." },
    ],
    maxRounds: 3,
    repositoryId: null,
    createdAt: "2026-11-04T10:00:00.000Z",
    filedAt: null,
    ...overrides,
  };
}

/** The server's sharding view; PATCH, POST and DELETE change it. */
let current: FeatureShardView;
let seen: SeenRequest[];

function serve() {
  seen = mockFetch({
    [`GET ${SHARD_PATH}`]: () => jsonResponse(current),
    [`POST ${SHARD_PATH}`]: () => {
      current = {
        ...current,
        shard: shardRow({
          status: "drafting",
          drafts: [],
          rounds: [{ number: 1, status: "working", passed: null, summary: null }],
        }),
      };
      return jsonResponse(current);
    },
    [`DELETE ${SHARD_PATH}`]: () => {
      current = { ...current, shard: { ...current.shard!, status: "canceled" } };
      return jsonResponse(current);
    },
    [`POST ${SHARD_PATH}/file`]: () => {
      const shard = current.shard!;
      current = {
        ...current,
        shard: {
          ...shard,
          status: "filed",
          drafts: shard.drafts.map((draft, index) =>
            draft.decision === "approved"
              ? { ...draft, filed: { identifier: `ENG-${index + 1}`, url: "https://linear.app/x" } }
              : draft,
          ),
        },
      };
      return jsonResponse(current);
    },
    "GET /api/ui/work-items/targets": () =>
      jsonResponse({
        targets: [REPO_ID, OTHER_REPO_ID].map((id, index) => ({
          repository: {
            id,
            provider: "github",
            fullPath: index === 0 ? "acme/portal" : "acme/api",
            name: index === 0 ? "portal" : "api",
          },
          organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
          tracker: "linear",
          team: index === 0 ? "ENG" : "API",
          project: index === 0 ? "Portal" : null,
        })),
      }),
    ...Object.fromEntries(
      ["E1", "E2"].map((key) => [
        `PATCH ${SHARD_PATH}/drafts/${key}`,
        (request: SeenRequest) => {
          const shard = current.shard!;
          const body = request.body as Partial<FeatureShardDraftRow>;
          current = {
            ...current,
            shard: {
              ...shard,
              drafts: shard.drafts.map((draft) =>
                draft.key === key
                  ? {
                      ...draft,
                      ...body,
                      edited:
                        draft.edited || body.title !== undefined || body.description !== undefined,
                    }
                  : draft,
              ),
            },
          };
          return jsonResponse(current);
        },
      ]),
    ),
  });
}

function renderPanel(user: SessionUser = testUser, editable = user.role === "admin") {
  return render(
    <CurrentUserProvider user={user}>
      <QueryClientProvider client={createTestQueryClient()}>
        <ShardPanel feature={feature} editable={editable} />
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
}

const draftCard = (key: string) => screen.findByRole("article", { name: new RegExp(`^${key}: `) });
const patches = () =>
  seen
    .filter((request) => request.method === "PATCH")
    .map((request) => [request.path, request.body]);

beforeEach(() => {
  ui.toast.mockReset();
  current = { shard: shardRow(), featureMapping: "omniralph", parentIssue: null };
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the feature's epics", () => {
  it("starts sharding the Plan and shows the round being drafted", async () => {
    current = { ...current, shard: null };
    renderPanel();
    expect(await screen.findByText(NO_SHARD)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: SHARD_ACTION }));
    expect(await screen.findByText("Round 1 of 3: drafting")).toBeTruthy();
    expect(seen.some((request) => request.method === "POST" && request.path === SHARD_PATH)).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: DISCARD_ACTION })).toBeTruthy();
  });

  it("shows each draft beside the Plan sections it covers, with the verifier's notes", async () => {
    current = {
      ...current,
      shard: shardRow({ leftovers: ["Epic E2 adds scope the Plan lacks: a billing page."] }),
    };
    renderPanel();
    const first = await draftCard("E1");
    expect(within(first).getByText("Epic E1")).toBeTruthy();
    expect(within(first).getByText("Builds the storage.")).toBeTruthy();
    const covers = within(first).getByRole("complementary", { name: "Plan sections E1 covers" });
    expect(within(covers).getByText("Storage")).toBeTruthy();
    expect(within(covers).getByText("Store invoices in Postgres.")).toBeTruthy();
    expect(within(await draftCard("E2")).getByText("After: Epic E1")).toBeTruthy();

    const leftovers = screen.getByRole("note", { name: LEFTOVERS_TITLE });
    expect(within(leftovers).getByText(/adds scope the Plan lacks/)).toBeTruthy();
    expect(screen.getByText("Round 1 of 3: sent back")).toBeTruthy();
    expect(screen.getByText("Round 2 of 3: passed")).toBeTruthy();
  });

  it("edits, removes and approves each draft, then files the approved ones in the chosen repo", async () => {
    renderPanel();
    const first = await draftCard("E1");
    await userEvent.click(within(first).getByRole("button", { name: "Edit" }));
    const title = within(first).getByRole("textbox", { name: "Title" });
    await userEvent.clear(title);
    await userEvent.type(title, "Store invoices");
    await userEvent.click(within(first).getByRole("button", { name: "Save" }));
    expect(await within(await draftCard("E1")).findByText("Edited")).toBeTruthy();

    await userEvent.click(within(await draftCard("E1")).getByRole("button", { name: "Approve" }));
    // Filing waits until every draft is decided.
    expect(await screen.findByText(UNDECIDED_HINT(1))).toBeTruthy();
    const file = screen.getByRole("button", { name: FILE_ACTION(1) }) as HTMLButtonElement;
    expect(file.disabled).toBe(true);

    await userEvent.click(within(await draftCard("E2")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText(UNDECIDED_HINT(1))).toBeNull());
    expect(patches()).toEqual([
      [
        `${SHARD_PATH}/drafts/E1`,
        { title: "Store invoices", description: "## Problem\n\nPeople need epic E1." },
      ],
      [`${SHARD_PATH}/drafts/E1`, { decision: "approved" }],
      [`${SHARD_PATH}/drafts/E2`, { decision: "removed" }],
    ]);

    expect(screen.getByText(new RegExp(MAPPING_OMNIRALPH.replace(/[.;]/g, ".")))).toBeTruthy();
    const repo = (await screen.findByRole("combobox", { name: "File in" })) as HTMLSelectElement;
    await waitFor(() => expect(repo.value).toBe(REPO_ID));
    expect(screen.getByText("Team ENG, project Portal.")).toBeTruthy();
    await userEvent.selectOptions(repo, OTHER_REPO_ID);
    await userEvent.click(screen.getByRole("button", { name: FILE_ACTION(1) }));

    expect(await screen.findByText("Filed as ENG-1")).toBeTruthy();
    const posted = seen.find((request) => request.path === `${SHARD_PATH}/file`);
    expect(posted?.body).toEqual({ repositoryId: OTHER_REPO_ID });
    expect(ui.toast).toHaveBeenCalledWith("Filed 1 epic. Om is triaging it into tasks.");
  });

  it("says the epics are filed under the feature's parent issue with that mapping", async () => {
    current = {
      ...current,
      featureMapping: "parent-issue",
      parentIssue: { identifier: "ENG-7", url: "https://linear.app/x" },
    };
    renderPanel();
    expect(await screen.findByText(new RegExp(`\\(ENG-7\\)`))).toBeTruthy();
    expect(screen.getByText(new RegExp(MAPPING_PARENT_ISSUE.slice(0, 40)))).toBeTruthy();
  });

  it("shows members the drafts without review or filing actions", async () => {
    renderPanel(member);
    const first = await draftCard("E1");
    expect(within(first).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: DISCARD_ACTION })).toBeNull();
    expect(screen.queryByRole("button", { name: /^File / })).toBeNull();
  });
});
