// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RALPH_SETTINGS, ralphSettingsFormValues } from "@omniralph/shared";
import {
  createTestQueryClient,
  mockFetch,
  queryWrapper,
  type SeenRequest,
} from "@/components/query-test-utils";
import { RepositorySettingsContent, type RepositorySettingsTab } from "./repository-settings-view";
import type { RalphSettingsValues } from "./ralph-settings-section";

const run = vi.fn((action: () => unknown) => action());
vi.mock("@/components/use-settings-save", () => ({
  useSettingsSave: () => ({ pending: false, run }),
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/repositories/repo-1/settings",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

let seen: SeenRequest[] = [];
/** The saves sent to `PUT /api/ui/repositories/repo-1/<part>`. */
const saves = (part: string) =>
  seen.filter((r) => r.method === "PUT" && r.path === `/api/ui/repositories/repo-1/${part}`);

const ralph: RalphSettingsValues = {
  storyPlaybookId: "builtin:implement-story",
  requestPlaybookId: "builtin:handle-request",
  ...ralphSettingsFormValues(DEFAULT_RALPH_SETTINGS),
};

const HARNESS = {
  online: true,
  revoked: false,
  updating: false,
  acceptedTaskTypes: ["review", "coding"],
};

function view(tab: RepositorySettingsTab, pinnedHarnessIds: string[] = []) {
  return render(
    <RepositorySettingsContent
      tab={tab}
      repository={{
        id: "repo-1",
        provider: "github",
        fullPath: "acme/app",
        webUrl: "https://github.com/acme/app",
      }}
      settings={{
        depth: "deep",
        triggers: { onOpen: true, onPush: true, drafts: false },
        pathExcludes: [],
        customInstructions: "",
        pinnedHarnessIds,
      }}
      harnesses={[
        { ...HARNESS, id: "h1", name: "build-01" },
        { ...HARNESS, id: "h2", name: "build-02", online: false },
      ]}
      ralph={ralph}
      codingChoices={{
        linear: { status: "disconnected" },
        models: [],
        harnessCount: 0,
        pinned: false,
        routingRules: [],
      }}
      taskTypes={{
        overrides: { query: null, review: null, coding: true },
        inherited: { query: true, review: true, coding: true },
      }}
    />,
    { wrapper: queryWrapper(createTestQueryClient()) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  seen = mockFetch({
    "PUT /api/ui/repositories/repo-1/coding": { ok: true },
    "PUT /api/ui/repositories/repo-1/settings": { ok: true },
    "PUT /api/ui/repositories/repo-1/task-types": { ok: true },
  });
});

describe("repository settings sections", () => {
  it("saves review settings with the repository's depth, which it can't change", async () => {
    const user = userEvent.setup();
    view("settings");
    expect(screen.queryByRole("radio", { name: /Deep|Standard|Quick/ })).toBeNull();
    await user.click(document.getElementById("trigger-drafts")!);
    await user.click(screen.getByRole("button", { name: "Save review settings" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(saves("settings")).toHaveLength(1));
    expect(saves("settings")[0]!.body).toMatchObject({
      depth: "deep",
      triggers: { onOpen: true, onPush: true, drafts: true },
    });
  });

  it("confirms the Coding section's change list before saving", async () => {
    const user = userEvent.setup();
    view("coding");
    await user.type(document.getElementById("ralph-append-instruction")!, "Keep commits small.");
    await user.click(screen.getByRole("button", { name: "Save coding" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Keep commits small\./)).toBeTruthy();
    expect(saves("coding")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(saves("coding")).toHaveLength(1));
  });

  it("confirms the Danger zone's change list before saving", async () => {
    const user = userEvent.setup();
    view("coding");
    await user.click(document.getElementById("ralph-cleanup")!);
    await user.click(screen.getByRole("button", { name: "Save danger zone" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Clean up after the merge/)).toBeTruthy();
    expect(saves("coding")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(saves("coding")).toHaveLength(1));
  });

  it("adds and removes pinned harnesses, with Discard reverting them", async () => {
    const user = userEvent.setup();
    view("harnesses", ["h1"]);
    await user.click(screen.getByRole("combobox", { name: /Pinned harnesses/ }));
    await user.click(await screen.findByRole("option", { name: /build-02/ }));
    await user.keyboard("{Escape}");
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove build-01" }));
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("button", { name: "Remove build-01" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove build-02" })).toBeNull();
    expect(screen.getByText("No unsaved changes")).toBeTruthy();
    expect(saves("settings")).toHaveLength(0);
  });
});
