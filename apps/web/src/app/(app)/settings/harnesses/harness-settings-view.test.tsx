// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as OmniralphUi from "@omniralph/ui";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  testUser,
  TEST_ORGANIZATION_ID,
} from "@/components/query-test-utils";
import type { HarnessDefaults, HostToolCatalogRow } from "@/lib/api/harness-defaults";
import { HarnessSettingsView } from "./harness-settings-view";

const navigation = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect ${path}`);
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/harnesses",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  redirect: navigation.redirect,
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
const toasts = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: toasts.toast,
}));

const DEFAULTS = "/api/ui/harness-defaults";
const HOST_TOOLS = "/api/ui/host-tools";
const builtIn = { maxConcurrency: 5 };

function harnessDefaults(overrides: Partial<HarnessDefaults> = {}): HarnessDefaults {
  return {
    desiredVersion: "1.4.0",
    updatedAt: null,
    latest: null,
    packageName: "@omniralph/agent",
    defaults: builtIn,
    builtInDefaults: builtIn,
    ...overrides,
  };
}

function renderView(
  tab: "defaults" | "host-tools" = "defaults",
  role: "admin" | "member" = "admin",
) {
  const client = createTestQueryClient();
  const result = render(<HarnessSettingsView tab={tab} />, {
    wrapper: queryWrapper(client, { ...testUser, role }),
  });
  return { client, ...result };
}

const version = () => screen.getByLabelText("Desired version") as HTMLInputElement;
const concurrency = () => screen.getByLabelText(/^Max concurrency/) as HTMLInputElement;

async function saveAndConfirm() {
  await userEvent.click(screen.getByRole("button", { name: /Save defaults/ }));
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(
    [...dialog.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent ?? ""))!,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  toasts.toast.mockReset();
});

describe("HarnessSettingsView › Defaults", () => {
  it("shows a skeleton, then concurrency and the harness version in one section with one save", async () => {
    mockFetch({ [`GET ${DEFAULTS}`]: harnessDefaults() });
    const { container } = renderView();
    expect(screen.getByLabelText("Loading the harness defaults")).toBeTruthy();
    await waitFor(() => expect(version().value).toBe("1.4.0"));
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(container.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Concurrency",
      "Harness version",
    ]);
  });

  it("sends members to the access-denied page", () => {
    mockFetch({});
    expect(() => renderView("defaults", "member")).toThrow(
      "redirect /access-denied?reason=forbidden",
    );
  });

  it("shows an error with a retry when the defaults don't load", async () => {
    let fail = true;
    mockFetch({
      [`GET ${DEFAULTS}`]: () =>
        fail
          ? jsonResponse({ error: "Database unavailable." }, 500)
          : jsonResponse(harnessDefaults()),
    });
    renderView();
    await screen.findByText("Couldn't load the harness defaults");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(version().value).toBe("1.4.0"));
  });

  it("re-seeds from fresh data unless the section is being edited", async () => {
    let desiredVersion = "1.4.0";
    mockFetch({ [`GET ${DEFAULTS}`]: () => jsonResponse(harnessDefaults({ desiredVersion })) });
    const { client } = renderView();
    await waitFor(() => expect(version().value).toBe("1.4.0"));

    desiredVersion = "1.5.0";
    await client.invalidateQueries();
    await waitFor(() => expect(version().value).toBe("1.5.0"));

    await userEvent.clear(concurrency());
    await userEvent.type(concurrency(), "8");
    desiredVersion = "1.6.0";
    await client.invalidateQueries();
    expect(version().value).toBe("1.5.0");
    expect(concurrency().value).toBe("8");
  });

  it("saves only what changed: the version alone", async () => {
    let desiredVersion = "1.4.0";
    const seen = mockFetch({
      [`GET ${DEFAULTS}`]: () => jsonResponse(harnessDefaults({ desiredVersion })),
      [`PUT ${DEFAULTS}`]: (request) => {
        desiredVersion = (request.body as { version: string }).version;
        return jsonResponse({ ok: true });
      },
    });
    renderView();
    await waitFor(() => expect(version().value).toBe("1.4.0"));
    await userEvent.click(screen.getByRole("button", { name: /Track latest on npm/ }));
    expect(version().value).toBe("latest");
    await saveAndConfirm();
    await screen.findByText("Saved");
    expect(seen.filter((r) => r.method === "PUT").map((r) => r.body)).toEqual([
      { version: "latest" },
    ]);
    expect(toasts.toast).toHaveBeenCalledWith(
      "Saved. Harnesses will follow the latest version on npm.",
    );
  });

  it("saves the defaults and the version in one request, and refetches the harnesses and repositories", async () => {
    let saved = harnessDefaults();
    const seen = mockFetch({
      [`GET ${DEFAULTS}`]: () => jsonResponse(saved),
      [`PUT ${DEFAULTS}`]: (request) => {
        const body = request.body as {
          defaults: HarnessDefaults["defaults"];
          version: string;
        };
        saved = harnessDefaults({ defaults: body.defaults, desiredVersion: body.version });
        return jsonResponse({ ok: true });
      },
    });
    const { client } = renderView();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await waitFor(() => expect(version().value).toBe("1.4.0"));
    const maxConcurrency = screen.getByLabelText("Max concurrency");
    await userEvent.clear(maxConcurrency);
    await userEvent.type(maxConcurrency, "6");
    await userEvent.clear(version());
    await userEvent.type(version(), "1.5.0");
    expect(screen.getByText("2 unsaved changes")).toBeTruthy();
    await saveAndConfirm();
    await screen.findByText("Saved");
    expect(seen.filter((r) => r.method === "PUT").map((r) => r.body)).toEqual([
      { defaults: { maxConcurrency: 6 }, version: "1.5.0" },
    ]);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      [TEST_ORGANIZATION_ID, "settings", "detail", "harness-defaults"],
      [TEST_ORGANIZATION_ID, "harnesses"],
      [TEST_ORGANIZATION_ID, "repositories"],
    ]);
    expect(version().value).toBe("1.5.0");
  });

  it("shows a failed save's error and keeps the draft", async () => {
    mockFetch({
      [`GET ${DEFAULTS}`]: harnessDefaults(),
      [`PUT ${DEFAULTS}`]: () =>
        jsonResponse({ error: "Enter a version like 1.4.0 or latest, or leave it blank." }, 400),
    });
    renderView();
    await waitFor(() => expect(version().value).toBe("1.4.0"));
    await userEvent.clear(version());
    await userEvent.type(version(), "next");
    await saveAndConfirm();
    await waitFor(() =>
      expect(toasts.toast).toHaveBeenCalledWith(
        "Enter a version like 1.4.0 or latest, or leave it blank.",
        expect.objectContaining({ variant: "danger" }),
      ),
    );
    expect(version().value).toBe("next");
  });
});

describe("HarnessSettingsView › Host tools", () => {
  const tool = (id: string, name: string, description: string | null = null) => ({
    id,
    name,
    description,
  });

  it("lists the host tools with their descriptions and a delete button, and the add form", async () => {
    mockFetch({
      [`GET ${HOST_TOOLS}`]: {
        hostTools: [tool("1", "opengrep"), tool("2", "semgrep", "SAST scanner")],
      },
    });
    const { container } = renderView("host-tools");
    expect(screen.getByLabelText("Loading the host tools")).toBeTruthy();
    await screen.findByLabelText("Delete semgrep");
    expect(
      [...container.querySelectorAll("[data-host-tool]")].map((row) =>
        row.getAttribute("data-host-tool"),
      ),
    ).toEqual(["opengrep", "semgrep"]);
    expect(screen.getAllByText("SAST scanner").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Delete opengrep")).toBeTruthy();
    expect(screen.getByRole("form", { name: "Add a host tool" })).toBeTruthy();
  });

  it("shows an empty state and the add form without host tools", async () => {
    mockFetch({ [`GET ${HOST_TOOLS}`]: { hostTools: [] } });
    renderView("host-tools");
    await screen.findByText("No host tools");
    expect(screen.getByRole("button", { name: /Add host tool/ })).toBeTruthy();
  });

  it("adds a host tool and lists it, without a reload", async () => {
    let hostTools: HostToolCatalogRow[] = [];
    const seen = mockFetch({
      [`GET ${HOST_TOOLS}`]: () => jsonResponse({ hostTools }),
      [`POST ${HOST_TOOLS}`]: (request) => {
        const body = request.body as { name: string; description: string };
        hostTools = [tool("t1", body.name.trim(), body.description || null)];
        return jsonResponse({ ok: true, hostToolId: "t1" });
      },
    });
    const { client } = renderView("host-tools");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await screen.findByText("No host tools");
    await userEvent.type(screen.getByLabelText(/^Name/), "semgrep");
    await userEvent.type(screen.getByLabelText(/^Description/), "SAST scanner");
    await userEvent.click(screen.getByRole("button", { name: /Add host tool/ }));
    await screen.findByLabelText("Delete semgrep");
    expect(seen.find((r) => r.method === "POST")!.body).toEqual({
      name: "semgrep",
      description: "SAST scanner",
    });
    // The form is cleared for the next one.
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("");
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      [TEST_ORGANIZATION_ID, "settings", "detail", "host-tools"],
      [TEST_ORGANIZATION_ID, "harnesses"],
      [TEST_ORGANIZATION_ID, "settings", "detail", "tasks"],
    ]);
  });

  it("keeps the form when adding fails", async () => {
    mockFetch({
      [`GET ${HOST_TOOLS}`]: { hostTools: [tool("1", "semgrep")] },
      [`POST ${HOST_TOOLS}`]: () =>
        jsonResponse({ error: "There already is a host tool named semgrep." }, 400),
    });
    renderView("host-tools");
    await screen.findByLabelText("Delete semgrep");
    await userEvent.type(screen.getByLabelText(/^Name/), "semgrep");
    await userEvent.click(screen.getByRole("button", { name: /Add host tool/ }));
    await waitFor(() =>
      expect(toasts.toast).toHaveBeenCalledWith(
        "There already is a host tool named semgrep.",
        expect.objectContaining({ variant: "danger" }),
      ),
    );
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("semgrep");
  });

  it("deletes a host tool after confirming and lists the catalog without it", async () => {
    let hostTools = [tool("t1", "semgrep"), tool("t2", "ruff")];
    const seen = mockFetch({
      [`GET ${HOST_TOOLS}`]: () => jsonResponse({ hostTools }),
      [`DELETE ${HOST_TOOLS}/t1`]: () => {
        hostTools = hostTools.filter((t) => t.id !== "t1");
        return jsonResponse({ ok: true });
      },
    });
    renderView("host-tools");
    await userEvent.click(await screen.findByLabelText("Delete semgrep"));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() => expect(screen.queryByLabelText("Delete semgrep")).toBeNull());
    expect(screen.getByLabelText("Delete ruff")).toBeTruthy();
    expect(seen.some((r) => r.method === "DELETE")).toBe(true);
    expect(toasts.toast).toHaveBeenCalledWith("Deleted semgrep");
  });
});
