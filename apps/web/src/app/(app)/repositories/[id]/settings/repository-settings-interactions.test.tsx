// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RALPH_SETTINGS, ralphSettingsFormValues } from "@omniralph/shared";
import { RepositorySettingsView, type RepositorySettingsTab } from "./repository-settings-view";
import type { RalphSettingsValues } from "./ralph-settings-section";
import { updateRalphSettings, updateRepositorySettings } from "./actions";

const run = vi.fn((action: () => unknown) => action());
vi.mock("@/components/use-action", () => ({ useAction: () => ({ pending: false, run }) }));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/current-user", () => ({ useCurrentUser: () => ({ role: "admin" }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/repositories/repo-1/settings",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  updateRalphSettings: vi.fn(async () => ({ ok: true })),
  updateRepositorySettings: vi.fn(async () => ({ ok: true })),
  updateRepositoryTaskTypes: vi.fn(async () => ({ ok: true })),
}));

const ralph: RalphSettingsValues = {
  linearTeamKeys: [],
  linearProjectNames: [],
  linearLabels: [],
  codingPath: "tasks",
  storyTaskId: "builtin:implement-story",
  requestTaskId: "builtin:handle-request",
  ...ralphSettingsFormValues(DEFAULT_RALPH_SETTINGS),
};

const HARNESS = {
  online: true,
  revoked: false,
  updating: false,
  acceptedTaskTypes: ["review", "coding"],
};

const PROFILE = { maxTokensPerReview: 200000, maxFiles: 50, allowRepoExploration: true };

function view(tab: RepositorySettingsTab, pinnedHarnessIds: string[] = []) {
  return render(
    <RepositorySettingsView
      tab={tab}
      repository={{
        id: "repo-1",
        provider: "github",
        fullPath: "acme/app",
        webUrl: "https://github.com/acme/app",
      }}
      settings={{
        profileId: "standard",
        triggers: { onOpen: true, onPush: true, drafts: false },
        pathExcludes: [],
        customInstructions: "",
        pinnedHarnessIds,
        reviewTaskIds: ["builtin:review-pr"],
        correlationTaskId: "builtin:correlate-findings",
      }}
      reviewTasks={[
        {
          id: "builtin:review-pr",
          name: "Review PR",
          description: "Reviews the change.",
          builtin: true,
        },
      ]}
      correlationTasks={[
        { id: "builtin:correlate-findings", name: "Correlate findings", builtin: true },
      ]}
      profiles={[
        { id: "standard", name: "Standard", description: null, model: "sonnet", ...PROFILE },
        { id: "deep", name: "Deep", description: null, model: "opus", ...PROFILE },
      ]}
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
      }}
      codingTasks={{
        story: [{ id: "builtin:implement-story", name: "Implement story", builtin: true }],
        request: [{ id: "builtin:handle-request", name: "Handle request", builtin: true }],
      }}
      taskTypes={{
        overrides: { query: null, review: null, coding: true },
        inherited: { query: true, review: true, coding: true },
      }}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("repository settings sections", () => {
  it("selects a review profile by clicking its row, and Discard reverts it", async () => {
    const user = userEvent.setup();
    view("settings");
    const checked = (name: RegExp) =>
      screen.getByRole("radio", { name }).getAttribute("aria-checked") === "true";
    expect(checked(/Deep/)).toBe(false);
    // The model cell, not the radio: the whole row is the target.
    await user.click(screen.getByText("opus"));
    expect(checked(/Deep/)).toBe(true);
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(checked(/Deep/)).toBe(false);
    expect(checked(/Standard/)).toBe(true);
  });

  it("confirms the Coding section's change list before saving", async () => {
    const user = userEvent.setup();
    view("coding");
    await user.type(document.getElementById("ralph-append-instruction")!, "Keep commits small.");
    await user.click(screen.getByRole("button", { name: "Save coding" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Keep commits small\./)).toBeTruthy();
    expect(updateRalphSettings).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Save 1 change" }));
    expect(updateRalphSettings).toHaveBeenCalledTimes(1);
  });

  it("confirms the Danger zone's change list before saving", async () => {
    const user = userEvent.setup();
    view("coding");
    await user.click(document.getElementById("ralph-cleanup")!);
    await user.click(screen.getByRole("button", { name: "Save danger zone" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Clean up after the merge/)).toBeTruthy();
    expect(updateRalphSettings).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Save 1 change" }));
    expect(updateRalphSettings).toHaveBeenCalledTimes(1);
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
    expect(updateRepositorySettings).not.toHaveBeenCalled();
  });
});
