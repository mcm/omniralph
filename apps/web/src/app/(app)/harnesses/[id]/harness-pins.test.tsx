// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HarnessRow } from "@/lib/harnesses/rows";
import { HarnessSettingsSection } from "./harness-detail-view";

const actions = vi.hoisted(() => ({
  searchPinnableRepositories: vi.fn(async (query: string) => ({
    ok: true as const,
    repositories: [
      { id: "repo-api", provider: "github" as const, fullPath: "acme/api" },
      { id: "repo-web", provider: "gitlab" as const, fullPath: "acme/web" },
    ].filter((repo) => repo.fullPath.includes(query)),
  })),
  pinRepository: vi.fn(async () => ({ ok: true }) as const),
  unpinRepository: vi.fn(async () => ({ ok: true }) as const),
  updateHarnessConfig: vi.fn(async () => ({ ok: true }) as const),
  setHarnessDesiredVersion: vi.fn(async () => ({ ok: true }) as const),
  requestHarnessUpdate: vi.fn(),
}));
vi.mock("../actions", () => actions);
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("../../jobs/actions", () => ({}));
vi.mock("../../repositories/actions", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const harness = {
  id: "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f",
  name: "build-01",
  revoked: false,
  acceptedTaskTypes: ["query", "review"],
  maxConcurrency: 6,
  overrides: { acceptedTaskTypes: null, maxConcurrency: null },
  defaults: { acceptedTaskTypes: ["query", "review"], maxConcurrency: 6 },
  poolLimits: {},
  effectivePoolLimits: { short: 6, long: 5 },
  updateRequest: null,
  selfUpdate: "unsupported",
  desiredVersionOverride: null,
  pinnedRepositories: [
    { id: "repo-old", provider: "github", fullPath: "acme/old", webUrl: "https://x/acme/old" },
  ],
} as unknown as HarnessRow;

describe("HarnessSettingsSection pins", () => {
  it("searches repositories on the server and saves the pin changes with the section", async () => {
    render(<HarnessSettingsSection harness={harness} globalDesiredVersion={null} />);
    await userEvent.click(screen.getByRole("combobox", { name: /Pinned repositories/ }));
    await userEvent.type(screen.getByRole("combobox", { name: "Search repositories" }), "web");
    await waitFor(() => expect(actions.searchPinnableRepositories).toHaveBeenLastCalledWith("web"));
    await userEvent.click(await screen.findByRole("option", { name: /acme\/web/ }));
    await userEvent.click(screen.getByRole("button", { name: /Remove acme\/old/ }));
    await userEvent.keyboard("{Escape}");

    expect(screen.getByText("1 unsaved change")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Save settings/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("acme/old");
    expect(dialog.textContent).toContain("acme/web");
    await userEvent.click(
      [...dialog.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent ?? ""))!,
    );
    await waitFor(() => expect(actions.pinRepository).toHaveBeenCalledWith(harness.id, "repo-web"));
    expect(actions.unpinRepository).toHaveBeenCalledWith(harness.id, "repo-old");
    expect(actions.updateHarnessConfig).not.toHaveBeenCalled();
    expect(actions.setHarnessDesiredVersion).not.toHaveBeenCalled();
  });
});
