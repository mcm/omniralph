// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as UI from "@iamthemcmaster/ui";
import { OrganizationSwitcher } from "./organization-switcher";
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

const OTHER = { id: "22222222-2222-4222-8222-222222222222", name: "Beta" };
const organizations = [{ id: testUser.organization.id, name: testUser.organization.name }, OTHER];

beforeEach(() => {
  vi.unstubAllGlobals();
  router.push.mockReset();
  router.refresh.mockReset();
  toast.notify.mockReset();
});
afterEach(cleanup);

async function pick(name: string | RegExp) {
  await userEvent.click(screen.getByRole("button", { name: /Switch organization/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name }));
}

describe("OrganizationSwitcher", () => {
  it("switches, then starts over from the dashboard in the new organization", async () => {
    const seen = mockFetch({ "POST /api/ui/organizations/switch": { ok: true } });
    render(<OrganizationSwitcher organizations={organizations} collapsed={false} />, {
      wrapper: queryWrapper(createTestQueryClient()),
    });
    await pick("Beta");
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(router.push).toHaveBeenCalledWith("/");
    expect(seen).toMatchObject([{ method: "POST", body: { organizationId: OTHER.id } }]);
    expect(toast.notify).toHaveBeenCalledWith("Switched to Beta");
  });

  it("stays put with the server's error when the switch is refused", async () => {
    mockFetch({
      "POST /api/ui/organizations/switch": () =>
        jsonResponse({ error: "You are not a member of that organization." }, 400),
    });
    render(<OrganizationSwitcher organizations={organizations} collapsed={false} />, {
      wrapper: queryWrapper(createTestQueryClient()),
    });
    await pick("Beta");
    await waitFor(() =>
      expect(toast.notify).toHaveBeenCalledWith("You are not a member of that organization.", {
        variant: "danger",
      }),
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("does nothing for the active organization", async () => {
    const seen = mockFetch({});
    render(<OrganizationSwitcher organizations={organizations} collapsed={false} />, {
      wrapper: queryWrapper(createTestQueryClient()),
    });
    await pick(/^Acme/);
    expect(seen).toEqual([]);
  });
});
