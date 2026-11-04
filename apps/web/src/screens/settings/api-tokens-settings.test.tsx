// @vitest-environment jsdom
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import type { ApiTokenRow } from "@/lib/api/api-tokens";
import { ApiTokensSettings } from "./api-tokens-settings";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/api-tokens",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

const laptop: ApiTokenRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Laptop",
  prefix: "omr_Ab3x",
  createdAt: "2026-10-20T10:00:00.000Z",
  lastUsedAt: null,
};
const NEW_TOKEN = `omr_${"N".repeat(43)}`;
const created: ApiTokenRow = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "CI",
  prefix: "omr_NNNN",
  createdAt: "2026-11-04T10:00:00.000Z",
  lastUsedAt: null,
};

let tokens: ApiTokenRow[];
let seen: SeenRequest[];
let createResponse: () => Response;

beforeEach(() => {
  ui.toast.mockReset();
  tokens = [laptop];
  createResponse = () => {
    tokens = [created, ...tokens];
    return jsonResponse({ apiToken: created, token: NEW_TOKEN });
  };
  seen = mockFetch({
    "GET /api/ui/api-tokens": () => jsonResponse({ tokens }),
    "POST /api/ui/api-tokens": () => createResponse(),
    [`DELETE /api/ui/api-tokens/${laptop.id}`]: () => jsonResponse({ ok: true }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderTokens() {
  render(
    <CurrentUserProvider user={{ ...testUser, role: "member" }}>
      <QueryClientProvider client={createTestQueryClient()}>
        <UiProvider linkComponent={TestLink}>
          <ApiTokensSettings />
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
}

const table = () => screen.findByRole("table", { name: "Your API tokens" });
async function tableRows() {
  return within(await table())
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .slice(0, 4)
        .map((cell) => cell.textContent),
    );
}
const posts = () =>
  seen.filter((request) => request.method === "POST" && request.path === "/api/ui/api-tokens");

describe("API tokens", () => {
  it("lists the member's tokens by prefix, never their value", async () => {
    renderTokens();
    expect(await tableRows()).toEqual([["Laptop", "omr_Ab3x…", "Oct 20, 2026", "Never"]]);
    expect(screen.getByText(/save PRFAQs and Plans in Acme as you/)).toBeTruthy();
  });

  it("shows an empty state without tokens", async () => {
    tokens = [];
    renderTokens();
    expect(await screen.findByRole("heading", { name: "No API tokens" })).toBeTruthy();
  });

  it("creates a token and shows it once, with the new row on top", async () => {
    renderTokens();
    await table();
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), " CI ");
    await userEvent.click(screen.getByRole("button", { name: "Create token" }));

    const shown = await screen.findByRole("textbox", { name: "Token CI" });
    expect((shown as HTMLInputElement).value).toBe(NEW_TOKEN);
    expect(screen.getByText(/it isn't shown again/)).toBeTruthy();
    expect(posts().map((request) => request.body)).toEqual([{ name: "CI" }]);
    await waitFor(async () =>
      expect((await tableRows()).map((row) => row[0])).toEqual(["CI", "Laptop"]),
    );
    // The list has the prefix only.
    expect(within(await table()).queryByText(NEW_TOKEN)).toBeNull();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("");
  });

  it("asks for a name before sending anything", async () => {
    renderTokens();
    await table();
    await userEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(screen.getByText("Name the token.")).toBeTruthy();
    expect(posts()).toEqual([]);
  });

  it("shows the server's refusal and no token", async () => {
    createResponse = () =>
      jsonResponse({ error: "You have 20 tokens.", code: "api_token_limit" }, 400);
    renderTokens();
    await table();
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "CI");
    await userEvent.click(screen.getByRole("button", { name: "Create token" }));
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("You have 20 tokens.", { variant: "danger" }),
    );
    expect(screen.queryByRole("textbox", { name: "Token CI" })).toBeNull();
  });

  it("confirms, then revokes the token and removes its row", async () => {
    renderTokens();
    await userEvent.click(within(await table()).getByRole("button", { name: "Revoke Laptop" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "Revoke Laptop?" })).toBeTruthy();
    expect(dialog.textContent).toContain("Tools using omr_Ab3x… stop working at once.");
    tokens = [];
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByRole("heading", { name: "No API tokens" })).toBeTruthy();
    expect(
      seen.some(
        (request) =>
          request.method === "DELETE" && request.path === `/api/ui/api-tokens/${laptop.id}`,
      ),
    ).toBe(true);
  });
});
