// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { UiProvider } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import type { WorkItemRow } from "@/lib/api/work-items";
import {
  blockedRow,
  labelBlockedRow,
  manualRow,
  refineRow,
  workItemRow,
} from "@/screens/backlog/test-fixtures";
import { StartEpicIconButton, TriageNowIconButton } from "./start-triage-buttons";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

let seen: SeenRequest[];

beforeEach(() => {
  const ok = () => jsonResponse({ ok: true });
  seen = mockFetch({
    "POST /api/ui/work-items/linear-issue-412/start": ok,
    "POST /api/ui/work-items/linear-issue-413/start": ok,
    "POST /api/ui/work-items/linear-issue-414/triage": ok,
    "POST /api/ui/work-items/linear-issue-415/start": ok,
    "POST /api/ui/work-items/linear-issue-415/triage": ok,
    "POST /api/ui/work-items/linear-issue-420/triage": ok,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderButton(button: ReactNode) {
  return render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={createTestQueryClient()}>
        <UiProvider>{button}</UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
}

const posts = (path: string) =>
  seen.filter((request) => request.method === "POST" && request.path === path);

/** Hovers the disabled button and answers its reason, after checking a click sends nothing. */
async function disabledReason(name: string, path: string): Promise<string> {
  const user = userEvent.setup();
  const button = screen.getByRole("button", { name });
  expect(button.getAttribute("aria-disabled")).toBe("true");
  await user.click(button);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(posts(path)).toHaveLength(0);
  await user.hover(button);
  return (await screen.findByRole("tooltip")).textContent ?? "";
}

describe("StartEpicIconButton", () => {
  it("starts an item nothing holds in one click", async () => {
    renderButton(<StartEpicIconButton item={workItemRow()} />);
    await userEvent.click(screen.getByRole("button", { name: "Start epic SOC-412" }));
    await waitFor(() => expect(posts("/api/ui/work-items/linear-issue-412/start")).toHaveLength(1));
  });

  it("is disabled for a relation-blocked item, saying what it waits for", async () => {
    renderButton(<StartEpicIconButton item={blockedRow()} />);
    expect(
      await disabledReason("Start epic SOC-413", "/api/ui/work-items/linear-issue-413/start"),
    ).toBe("Starts when SOC-398 and SOC-401 are done");
  });

  it("names the blocked label, which wins over blockers", async () => {
    const row: WorkItemRow = { ...blockedRow(), blockedLabels: ["on hold", "Under-Review"] };
    renderButton(<StartEpicIconButton item={row} />);
    expect(
      await disabledReason("Start epic SOC-413", "/api/ui/work-items/linear-issue-413/start"),
    ).toBe("Labeled on hold and Under-Review, which keeps Om off it");
  });

  it("names the manual label, which wins over blocked", async () => {
    const row: WorkItemRow = { ...manualRow(), blocked: true, blockedLabels: ["on hold"] };
    renderButton(<StartEpicIconButton item={row} />);
    expect(
      await disabledReason("Start epic SOC-415", "/api/ui/work-items/linear-issue-415/start"),
    ).toBe("Labeled manual: this is a person's job");
  });
});

describe("TriageNowIconButton", () => {
  it("triages a blocked item", async () => {
    renderButton(<TriageNowIconButton item={labelBlockedRow()} />);
    await userEvent.click(screen.getByRole("button", { name: "Triage now SOC-414" }));
    await waitFor(() =>
      expect(posts("/api/ui/work-items/linear-issue-414/triage")).toHaveLength(1),
    );
  });

  it("is disabled for a manual item, naming its manual label", async () => {
    const row: WorkItemRow = { ...manualRow(), group: "refine", manualLabels: ["By hand"] };
    renderButton(<TriageNowIconButton item={row} />);
    expect(
      await disabledReason("Triage now SOC-415", "/api/ui/work-items/linear-issue-415/triage"),
    ).toBe("Labeled By hand: this is a person's job");
  });

  it("is disabled while Om triages, saying so", async () => {
    renderButton(<TriageNowIconButton item={{ ...refineRow(), triageRunning: true }} />);
    expect(
      await disabledReason("Triage now SOC-420", "/api/ui/work-items/linear-issue-420/triage"),
    ).toBe("Om is triaging SOC-420");
  });
});
