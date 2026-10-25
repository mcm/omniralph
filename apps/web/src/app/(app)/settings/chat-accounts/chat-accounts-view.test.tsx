// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
} from "@/components/query-test-utils";
import type * as OmniralphUi from "@omniralph/ui";
import type { ChatAccount } from "@/lib/api/organization";
import { ChatAccountsView } from "./chat-accounts-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
const toasts = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: toasts.toast,
}));

const account: ChatAccount = {
  organizationId: "33333333-3333-4333-8333-333333333333",
  organizationName: "Acme",
  platform: "slack",
  externalUserId: "U1",
  displayName: "ada",
  source: "email",
  linkedAt: "2026-10-16T10:00:00.000Z",
};

beforeEach(() => {
  vi.unstubAllGlobals();
  toasts.toast.mockReset();
});

describe("ChatAccountsView", () => {
  it("shows a skeleton, then the linked accounts, and unlinks one without a reload", async () => {
    let identities = [account];
    const seen = mockFetch({
      "GET /api/ui/chat-accounts": () => jsonResponse({ identities }),
      "POST /api/ui/chat-accounts/unlink": () => {
        identities = [];
        return jsonResponse({ ok: true });
      },
    });
    render(<ChatAccountsView />, { wrapper: queryWrapper(createTestQueryClient()) });
    expect(screen.getByLabelText("Loading your chat accounts")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("ada")).toBeTruthy());
    expect(screen.getByText(/linked automatically by email/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await userEvent.click(await screen.findByRole("button", { name: "Unlink" }));
    await waitFor(() =>
      expect(screen.getByText("No chat accounts are linked to you.")).toBeTruthy(),
    );
    expect(seen.find((r) => r.method === "POST")!.body).toEqual({
      organizationId: account.organizationId,
      platform: "slack",
      externalUserId: "U1",
    });
    expect(toasts.toast).toHaveBeenCalledWith("Unlinked ada");
  });

  it("shows accounts linked through the bot elsewhere when the list refetches", async () => {
    let identities: ChatAccount[] = [];
    mockFetch({ "GET /api/ui/chat-accounts": () => jsonResponse({ identities }) });
    const client = createTestQueryClient();
    render(<ChatAccountsView />, { wrapper: queryWrapper(client) });
    await waitFor(() =>
      expect(screen.getByText("No chat accounts are linked to you.")).toBeTruthy(),
    );
    identities = [{ ...account, source: "manual", displayName: null }];
    await client.invalidateQueries();
    await waitFor(() => expect(screen.getByText("U1")).toBeTruthy());
  });

  it("shows an error with a retry", async () => {
    let fail = true;
    mockFetch({
      "GET /api/ui/chat-accounts": () =>
        fail ? jsonResponse({ error: "Down." }, 500) : jsonResponse({ identities: [] }),
    });
    render(<ChatAccountsView />, { wrapper: queryWrapper(createTestQueryClient()) });
    await waitFor(() => expect(screen.getByText("Couldn't load your chat accounts")).toBeTruthy());
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() =>
      expect(screen.getByText("No chat accounts are linked to you.")).toBeTruthy(),
    );
  });
});
