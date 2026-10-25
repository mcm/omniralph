// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as UI from "@iamthemcmaster/ui";
import type { SessionUser } from "./current-user";
import { OrganizationPicker } from "./organization-picker";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  testUser,
} from "./query-test-utils";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("@iamthemcmaster/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof UI>()),
  notify: toast.notify,
}));

const ACME = testUser.organization;
const BETA = { id: "22222222-2222-4222-8222-222222222222", name: "Beta" };
const twoOrganizations: SessionUser = {
  ...testUser,
  organizations: [
    { ...ACME, role: "admin" },
    { ...BETA, role: "member" },
  ],
};

let startHref: string;
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.unstubAllGlobals();
  router.push.mockReset();
  router.refresh.mockReset();
  toast.notify.mockReset();
  startHref = window.location.href;
  consoleError = vi.spyOn(console, "error");
});
afterEach(() => {
  // A `window.location` assignment would navigate (jsdom reports it as not implemented).
  expect(window.location.href).toBe(startHref);
  expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/navigation/i);
  consoleError.mockRestore();
});

function renderPicker(user: SessionUser) {
  const client = createTestQueryClient();
  render(<OrganizationPicker />, { wrapper: queryWrapper(client, user) });
  return client;
}

const trigger = (name: string) => screen.getByRole("button", { name: `Organization: ${name}` });

async function open(name: string) {
  await userEvent.click(trigger(name));
  return screen.findByRole("menu");
}

/** The menu's entries in order, as `label` (`label ✓` when checked). */
function entries(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')).map(
    (item) =>
      item.getAttribute("aria-checked") === "true"
        ? `${item.textContent} ✓`
        : (item.textContent ?? ""),
  );
}

describe("OrganizationPicker", () => {
  it("offers no All organizations to a one-organization user", async () => {
    renderPicker(testUser);
    expect(trigger("Acme").textContent).toContain("Acme");
    const menu = await open("Acme");
    expect(entries(menu)).toEqual(["Acme ✓", "New organization"]);
    expect(within(menu).queryByRole("menuitemcheckbox", { name: "All organizations" })).toBeNull();
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
  });

  it("lists All organizations first for a two-organization user, then each organization", async () => {
    renderPicker(twoOrganizations);
    const menu = await open("Acme");
    expect(entries(menu)).toEqual(["All organizations", "Acme ✓", "Beta", "New organization"]);
    expect(
      within(menu).getByRole("menuitemcheckbox", { name: "Acme", checked: true }),
    ).toBeTruthy();
  });

  it("checks and names All organizations while that is the scope", async () => {
    renderPicker({ ...twoOrganizations, scope: "all" });
    const menu = await open("All organizations");
    expect(entries(menu)).toEqual(["All organizations ✓", "Acme", "Beta", "New organization"]);
  });

  it("switches to all organizations, then starts over in the new scope without a reload", async () => {
    const seen = mockFetch({ "POST /api/ui/organizations/switch": { ok: true } });
    const client = renderPicker(twoOrganizations);
    const cancel = vi.spyOn(client, "cancelQueries");
    await open("Acme");
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "All organizations" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(seen).toMatchObject([
      { method: "POST", path: "/api/ui/organizations/switch", body: { scope: "all" } },
    ]);
    expect(cancel).toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith("/");
    // The trigger shows the new choice before the shell re-renders.
    expect(trigger("All organizations")).toBeTruthy();
  });

  it("switches to one organization with its ID", async () => {
    const seen = mockFetch({ "POST /api/ui/organizations/switch": { ok: true } });
    renderPicker({ ...twoOrganizations, scope: "all" });
    await open("All organizations");
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Beta" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(seen).toMatchObject([{ method: "POST", body: { organizationId: BETA.id } }]);
    expect(router.push).toHaveBeenCalledWith("/");
    expect(trigger("Beta")).toBeTruthy();
  });

  it("switches from all organizations back to the active one", async () => {
    const seen = mockFetch({ "POST /api/ui/organizations/switch": { ok: true } });
    renderPicker({ ...twoOrganizations, scope: "all" });
    await open("All organizations");
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Acme" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(seen).toMatchObject([{ body: { organizationId: ACME.id } }]);
  });

  it("stays put with the server's error when the switch is refused", async () => {
    mockFetch({
      "POST /api/ui/organizations/switch": () =>
        jsonResponse(
          { error: "You need to belong to more than one organization to see all of them." },
          400,
        ),
    });
    renderPicker(twoOrganizations);
    await open("Acme");
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "All organizations" }));
    await waitFor(() =>
      expect(toast.notify).toHaveBeenCalledWith(
        "You need to belong to more than one organization to see all of them.",
        { variant: "danger" },
      ),
    );
    expect(router.push).not.toHaveBeenCalled();
    expect(trigger("Acme")).toBeTruthy();
  });

  it("does nothing for the current choice", async () => {
    const seen = mockFetch({});
    renderPicker(twoOrganizations);
    await open("Acme");
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Acme" }));
    expect(seen).toEqual([]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("goes to onboarding for a new organization", async () => {
    renderPicker(testUser);
    await open("Acme");
    await userEvent.click(screen.getByRole("menuitem", { name: "New organization" }));
    expect(router.push).toHaveBeenCalledWith("/onboarding");
  });
});
