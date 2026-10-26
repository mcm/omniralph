// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  mockFetch,
  queryWrapper,
  type SeenRequest,
} from "@/components/query-test-utils";
import { RepositorySettingsContent, type RepositorySettingsTab } from "./repository-settings-view";

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

const AGENT = {
  online: true,
  revoked: false,
  updating: false,
  acceptedTaskTypes: ["review", "coding"],
};

function view(tab: RepositorySettingsTab, pinnedAgentIds: string[] = []) {
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
        pinnedAgentIds,
      }}
      agents={[
        { ...AGENT, id: "h1", name: "build-01" },
        { ...AGENT, id: "h2", name: "build-02", online: false },
      ]}
      taskTypes={{ reviews: true, coding: true, ask: true }}
    />,
    { wrapper: queryWrapper(createTestQueryClient()) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  seen = mockFetch({
    "PUT /api/ui/repositories/repo-1/settings": { ok: true },
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

  it("adds and removes pinned agents, with Discard reverting them", async () => {
    const user = userEvent.setup();
    view("agents", ["h1"]);
    await user.click(screen.getByRole("combobox", { name: /Pinned agents/ }));
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
