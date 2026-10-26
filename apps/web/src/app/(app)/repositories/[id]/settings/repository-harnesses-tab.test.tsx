// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createTestQueryClient, queryWrapper } from "@/components/query-test-utils";
import { RepositorySettingsContent, type RepositoryHarness } from "./repository-settings-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/repositories/repo-1/harnesses",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const harness = (overrides: Partial<RepositoryHarness> & Pick<RepositoryHarness, "id" | "name">) =>
  ({
    online: true,
    revoked: false,
    updating: false,
    acceptedTaskTypes: ["query", "review"],
    ...overrides,
  }) satisfies RepositoryHarness;

const HARNESSES: RepositoryHarness[] = [
  harness({ id: "h1", name: "build-01", acceptedTaskTypes: ["review", "coding"] }),
  harness({ id: "h2", name: "build-02", online: false, acceptedTaskTypes: ["query"] }),
  harness({ id: "h3", name: "build-03", updating: true, acceptedTaskTypes: [] }),
  harness({ id: "h4", name: "old-01", revoked: true }),
];

function renderTab(pinnedAgentIds: string[] = []) {
  return render(
    <RepositorySettingsContent
      tab="harnesses"
      repository={{
        id: "repo-1",
        provider: "github",
        fullPath: "acme/app",
        webUrl: "https://github.com/acme/app",
      }}
      settings={{
        depth: "standard",
        triggers: { onOpen: true, onPush: true, drafts: false },
        pathExcludes: [],
        customInstructions: "",
        pinnedAgentIds,
      }}
      harnesses={HARNESSES}
      taskTypes={{ reviews: true, coding: true, ask: true }}
    />,
    { wrapper: queryWrapper(createTestQueryClient()) },
  );
}

const pinnedList = () => screen.getByRole("list", { name: "Pinned harnesses" });

describe("Repository › Harnesses pinned harnesses", () => {
  it("hints each option's status and accepted task types; revoked ones aren't offered", async () => {
    renderTab();
    await userEvent.click(screen.getByRole("combobox", { name: /Pinned harnesses/ }));
    const option = (name: string) => screen.getByRole("option", { name: new RegExp(name) });
    expect(option("build-01").textContent).toContain("Online · Review, Coding");
    expect(option("build-02").textContent).toContain("Offline · Query");
    expect(option("build-03").textContent).toContain("Updating · No task types");
    expect(screen.queryByRole("option", { name: /old-01/ })).toBeNull();
  });

  it("says jobs go to any eligible harness when none is pinned", () => {
    renderTab();
    expect(screen.getByText("None pinned: jobs go to any eligible harness")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Pinned harnesses" })).toBeNull();
  });

  it("lists the pinned harnesses below the picker with their status badges", () => {
    renderTab(["h1", "h2", "h3", "h4"]);
    const items = within(pinnedList()).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/build-01.*Review, Coding.*Online/),
      expect.stringMatching(/build-02.*Query.*Offline/),
      expect.stringMatching(/build-03.*Online.*Updating/),
      expect.stringMatching(/old-01.*Revoked/),
    ]);
    expect(screen.queryByText(/None pinned/)).toBeNull();
  });

  it("adds a picked harness to the list", async () => {
    renderTab();
    await userEvent.click(screen.getByRole("combobox", { name: /Pinned harnesses/ }));
    await userEvent.click(screen.getByRole("option", { name: /build-02/ }));
    await userEvent.keyboard("{Escape}");
    expect(within(pinnedList()).getByText("build-02")).toBeTruthy();
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
  });

  it("removes a pin from the list, back to the empty text", async () => {
    renderTab(["h1"]);
    await userEvent.click(within(pinnedList()).getByRole("button", { name: "Unpin build-01" }));
    expect(screen.getByText("None pinned: jobs go to any eligible harness")).toBeTruthy();
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(within(pinnedList()).getByText("build-01")).toBeTruthy();
  });
});
