// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createTestQueryClient, mockFetch, queryWrapper } from "@/components/query-test-utils";
import type { HarnessRow } from "@/lib/harnesses/rows";
import { HarnessSettingsSection } from "./harness-detail-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("../../jobs/actions", () => ({}));
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
    const repositories = [
      { id: "repo-api", provider: "github" as const, fullPath: "acme/api" },
      { id: "repo-web", provider: "gitlab" as const, fullPath: "acme/web" },
    ];
    const requests = mockFetch({
      "GET /api/ui/harnesses/pinnable-repositories": ({ query }) =>
        new Response(
          JSON.stringify({
            repositories: repositories.filter((r) => r.fullPath.includes(query.get("query") ?? "")),
          }),
        ),
      [`PUT /api/ui/harnesses/${harness.id}/settings`]: {
        ok: true,
        savedAt: "2026-10-16T10:00:00.000Z",
      },
    });
    render(<HarnessSettingsSection harness={harness} globalDesiredVersion={null} />, {
      wrapper: queryWrapper(createTestQueryClient()),
    });
    await userEvent.click(screen.getByRole("combobox", { name: /Pinned repositories/ }));
    await userEvent.type(screen.getByRole("combobox", { name: "Search repositories" }), "web");
    await waitFor(() =>
      expect(
        requests
          .filter((r) => r.path.endsWith("/pinnable-repositories"))
          .at(-1)
          ?.query.get("query"),
      ).toBe("web"),
    );
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
    // The pins alone, in the one request of the save.
    await waitFor(() =>
      expect(requests.filter((r) => r.method === "PUT").map((r) => r.body)).toEqual([
        { unpin: ["repo-old"], pin: ["repo-web"] },
      ]),
    );
  });
});
