// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  testUser,
} from "@/components/query-test-utils";
import type * as OmniralphUi from "@omniralph/ui";
import type { RepositoryRules } from "@/lib/api/rules";
import type { RuleView } from "@/lib/rules/display";
import { RulesView } from "./rules-view";

const REPOSITORY_ID = "11111111-2222-4333-8444-555555555555";
const RULES_PATH = `/api/ui/repositories/${REPOSITORY_ID}/rules`;

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: REPOSITORY_ID }),
  usePathname: () => `/repositories/${REPOSITORY_ID}/rules`,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
const toasts = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: toasts.toast,
}));

function rule(n: number, overrides: Partial<RuleView> = {}): RuleView {
  return {
    id: `66666666-7777-4888-8999-${String(n).padStart(12, "0")}`,
    kind: "custom",
    text: `Rule number ${n}`,
    enabled: true,
    createdAt: "2026-10-16T10:00:00.000Z",
    createdBy: "Ada Admin",
    sourceFinding: null,
    ...overrides,
  };
}

function rulesOf(rules: RuleView[]): RepositoryRules {
  return {
    repository: {
      id: REPOSITORY_ID,
      provider: "github",
      fullPath: "acme/api",
      webUrl: "https://github.com/acme/api",
    },
    rules,
  };
}

function renderView(role: "admin" | "member" = "admin") {
  const client = createTestQueryClient();
  const view = render(<RulesView />, { wrapper: queryWrapper(client, { ...testUser, role }) });
  return { client, view };
}

/** The table row showing `text`. */
function row(text: string) {
  return screen.getByText(text).closest("tr") as HTMLElement;
}

function enabledSwitch(text: string) {
  return within(row(text)).getByRole("switch");
}

beforeEach(() => {
  vi.unstubAllGlobals();
  toasts.toast.mockReset();
});

describe("RulesView", () => {
  it("shows a skeleton, then the repository's rules with when they were fetched", async () => {
    mockFetch({
      [`GET ${RULES_PATH}`]: rulesOf([
        rule(1),
        rule(2, {
          kind: "learned",
          createdBy: null,
          sourceFinding: {
            href: "/runs/r?step=p&tab=findings#finding-f",
            title: "Null check",
            path: "a.ts",
          },
        }),
      ]),
    });
    renderView();
    expect(screen.getByLabelText("Loading the rules")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Rule number 1")).toBeTruthy());
    expect(screen.getByText("Rule number 2")).toBeTruthy();
    expect(screen.getAllByText("Null check").length).toBeGreaterThan(0);
    expect(document.querySelector(".freshness")?.textContent).toMatch(/^Updated /);
  });

  it("shows rules added or learned elsewhere when the rules refetch", async () => {
    let rules = [rule(1)];
    const seen = mockFetch({ [`GET ${RULES_PATH}`]: () => jsonResponse(rulesOf(rules)) });
    const { client } = renderView();
    await waitFor(() => expect(screen.getByText("Rule number 1")).toBeTruthy());
    expect(seen[0]!.query.get("next")).toBe("/");
    rules = [rule(1), rule(2, { kind: "learned", createdBy: null })];
    await client.invalidateQueries();
    await waitFor(() => expect(screen.getByText("Rule number 2")).toBeTruthy());
  });

  it("moves a switch at once and keeps it there once the change is saved", async () => {
    let rules = [rule(1)];
    let release: () => void = () => {};
    const seen = mockFetch({
      [`GET ${RULES_PATH}`]: () => jsonResponse(rulesOf(rules)),
      [`PATCH ${RULES_PATH}/${rule(1).id}`]: async (request) => {
        await new Promise<void>((resolve) => (release = resolve));
        rules = [rule(1, { enabled: (request.body as { enabled: boolean }).enabled })];
        return jsonResponse({ ok: true });
      },
    });
    renderView();
    await waitFor(() =>
      expect(enabledSwitch("Rule number 1").getAttribute("aria-checked")).toBe("true"),
    );

    await userEvent.click(enabledSwitch("Rule number 1"));
    // Before the server answers: off, marked disabled, and held until the change settles.
    expect(enabledSwitch("Rule number 1").getAttribute("aria-checked")).toBe("false");
    expect(within(row("Rule number 1")).getByText("Disabled")).toBeTruthy();
    expect(enabledSwitch("Rule number 1").hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(seen.some((request) => request.method === "PATCH")).toBe(true));
    expect(seen.find((request) => request.method === "PATCH")!.body).toEqual({ enabled: false });

    release();
    await waitFor(() => expect(toasts.toast).toHaveBeenCalledWith("Rule disabled"));
    await waitFor(() =>
      expect(enabledSwitch("Rule number 1").hasAttribute("disabled")).toBe(false),
    );
    expect(enabledSwitch("Rule number 1").getAttribute("aria-checked")).toBe("false");
  });

  it("rolls a switch back with the server's error when the change fails", async () => {
    let release: () => void = () => {};
    mockFetch({
      [`GET ${RULES_PATH}`]: rulesOf([rule(1)]),
      [`PATCH ${RULES_PATH}/${rule(1).id}`]: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return jsonResponse({ error: "That rule doesn't exist." }, 400);
      },
    });
    renderView();
    await waitFor(() => expect(screen.getByText("Rule number 1")).toBeTruthy());

    await userEvent.click(enabledSwitch("Rule number 1"));
    expect(enabledSwitch("Rule number 1").getAttribute("aria-checked")).toBe("false");

    release();
    await waitFor(() =>
      expect(toasts.toast).toHaveBeenCalledWith("That rule doesn't exist.", { variant: "danger" }),
    );
    await waitFor(() =>
      expect(enabledSwitch("Rule number 1").getAttribute("aria-checked")).toBe("true"),
    );
    expect(within(row("Rule number 1")).queryByText("Disabled")).toBeNull();
  });

  it("adds a rule and shows it in the list without a reload", async () => {
    let rules: RuleView[] = [];
    const seen = mockFetch({
      [`GET ${RULES_PATH}`]: () => jsonResponse(rulesOf(rules)),
      [`POST ${RULES_PATH}`]: (request) => {
        rules = [rule(1, { text: (request.body as { text: string }).text })];
        return jsonResponse({ ok: true });
      },
    });
    renderView();
    await waitFor(() => expect(screen.getByText("No custom rules")).toBeTruthy());

    await userEvent.type(screen.getByLabelText("Rule"), "Flag TODOs.");
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(screen.getByText("Flag TODOs.")).toBeTruthy());
    expect(seen.find((request) => request.method === "POST")!.body).toEqual({
      text: "Flag TODOs.",
    });
    expect(toasts.toast).toHaveBeenCalledWith("Rule added; it applies to the next review");
    expect((screen.getByLabelText("Rule") as HTMLTextAreaElement).value).toBe("");
  });

  it("shows the server's field error on the add form", async () => {
    mockFetch({
      [`GET ${RULES_PATH}`]: rulesOf([]),
      [`POST ${RULES_PATH}`]: () =>
        jsonResponse({ error: "Too long.", fieldErrors: { text: "Too long." } }, 400),
    });
    renderView();
    await waitFor(() => expect(screen.getByText("No custom rules")).toBeTruthy());
    await userEvent.type(screen.getByLabelText("Rule"), "Flag TODOs.");
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(screen.getByText("Too long.")).toBeTruthy());
    expect((screen.getByLabelText("Rule") as HTMLTextAreaElement).value).toBe("Flag TODOs.");
  });

  it("edits and deletes a rule, updating the list without a reload", async () => {
    let rules = [rule(1)];
    mockFetch({
      [`GET ${RULES_PATH}`]: () => jsonResponse(rulesOf(rules)),
      [`PATCH ${RULES_PATH}/${rule(1).id}`]: (request) => {
        rules = [rule(1, { text: (request.body as { text: string }).text })];
        return jsonResponse({ ok: true });
      },
      [`DELETE ${RULES_PATH}/${rule(1).id}`]: () => {
        rules = [];
        return jsonResponse({ ok: true });
      },
    });
    renderView();
    await waitFor(() => expect(screen.getByText("Rule number 1")).toBeTruthy());

    await userEvent.click(within(row("Rule number 1")).getByRole("button", { name: "Edit rule" }));
    const dialog = await screen.findByRole("dialog");
    const text = within(dialog).getByLabelText("Rule");
    await userEvent.clear(text);
    await userEvent.type(text, "Flag TODOs without a link.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Flag TODOs without a link.")).toBeTruthy();

    await userEvent.click(
      within(row("Flag TODOs without a link.")).getByRole("button", { name: "Delete rule" }),
    );
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByText("Delete"));
    await waitFor(() => expect(screen.getByText("No custom rules")).toBeTruthy());
    expect(toasts.toast).toHaveBeenCalledWith("Rule deleted");
  });

  it("shows members the rules read-only", async () => {
    mockFetch({ [`GET ${RULES_PATH}`]: rulesOf([rule(1)]) });
    renderView("member");
    await waitFor(() => expect(screen.getByText("Rule number 1")).toBeTruthy());
    expect(enabledSwitch("Rule number 1").hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Add rule" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit rule" })).toBeNull();
  });

  it("shows a failed load in place with a retry", async () => {
    let fail = true;
    mockFetch({
      [`GET ${RULES_PATH}`]: () =>
        fail
          ? jsonResponse({ error: "Database unavailable." }, 500)
          : jsonResponse(rulesOf([rule(1)])),
    });
    renderView();
    await waitFor(() => expect(screen.getByText("Couldn't load the rules")).toBeTruthy(), {
      timeout: 5000,
    });
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry|Try again/ }));
    await waitFor(() => expect(screen.getByText("Rule number 1")).toBeTruthy());
  });
});
