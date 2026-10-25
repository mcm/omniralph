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
  testUser,
} from "@/components/query-test-utils";
import type * as OmniralphUi from "@omniralph/ui";
import type { OrganizationSettings } from "@/lib/api/organization";
import { OrganizationSettingsView } from "./organization-settings-view";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/organization",
  useRouter: () => router,
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
const toasts = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: toasts.toast,
}));

const PATH = "/api/ui/organization";
const INVITATION_ID = "22222222-3333-4444-8555-666666666666";

function settings(overrides: Partial<OrganizationSettings> = {}): OrganizationSettings {
  return {
    organization: { id: testUser.organization.id, name: "Acme", allowDomainJoin: false },
    isAdmin: true,
    currentUserId: testUser.id,
    domains: ["acme.io"],
    members: [
      {
        id: testUser.id,
        name: "Ada",
        email: "ada@acme.io",
        image: null,
        role: "admin",
        joinedAt: "2026-10-01T10:00:00.000Z",
      },
    ],
    invitations: [],
    ...overrides,
  };
}

function renderView(role: "admin" | "member" = "admin") {
  const client = createTestQueryClient();
  render(<OrganizationSettingsView />, { wrapper: queryWrapper(client, { ...testUser, role }) });
  return client;
}

const nameField = () => screen.getByLabelText(/^Name/) as HTMLInputElement;
const domainJoin = () => screen.getByRole("switch");

beforeEach(() => {
  vi.unstubAllGlobals();
  toasts.toast.mockReset();
  router.refresh.mockReset();
  router.push.mockReset();
});

describe("OrganizationSettingsView", () => {
  it("shows a skeleton, then the organization's settings", async () => {
    mockFetch({ [`GET ${PATH}`]: settings() });
    renderView();
    expect(screen.getByLabelText("Loading the organization")).toBeTruthy();
    await waitFor(() => expect(nameField().value).toBe("Acme"));
    expect(screen.getByText("acme.io")).toBeTruthy();
    expect(screen.getByText("No pending invitations.")).toBeTruthy();
  });

  it("shows an error with a retry when the settings don't load", async () => {
    let fail = true;
    mockFetch({
      [`GET ${PATH}`]: () =>
        fail ? jsonResponse({ error: "Database down." }, 500) : jsonResponse(settings()),
    });
    renderView();
    await waitFor(() => expect(screen.getByText("Couldn't load the organization")).toBeTruthy());
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(nameField().value).toBe("Acme"));
  });

  it("re-seeds the name from fresh data unless it's being edited", async () => {
    let name = "Acme";
    mockFetch({
      [`GET ${PATH}`]: () =>
        jsonResponse(settings({ organization: { id: "o", name, allowDomainJoin: false } })),
    });
    const client = renderView();
    await waitFor(() => expect(nameField().value).toBe("Acme"));

    // Renamed elsewhere: the untouched field follows.
    name = "Acme Corp";
    await client.invalidateQueries();
    await waitFor(() => expect(nameField().value).toBe("Acme Corp"));

    // Being edited: a refetch leaves the draft alone.
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Mine");
    name = "Acme Inc";
    await client.invalidateQueries();
    await waitFor(() => expect(screen.getByText(/Settings for Acme Inc/)).toBeTruthy());
    expect(nameField().value).toBe("Mine");
  });

  it("renames, refetches and refreshes the shell for the sidebar", async () => {
    let name = "Acme";
    const seen = mockFetch({
      [`GET ${PATH}`]: () =>
        jsonResponse(settings({ organization: { id: "o", name, allowDomainJoin: false } })),
      [`PATCH ${PATH}`]: (request) => {
        name = (request.body as { name: string }).name;
        return jsonResponse({ ok: true });
      },
    });
    renderView();
    await waitFor(() => expect(nameField().value).toBe("Acme"));
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Acme Corp");
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(seen.find((r) => r.method === "PATCH")!.body).toEqual({ name: "Acme Corp" });
    expect(toasts.toast).toHaveBeenCalledWith("Renamed to Acme Corp");
    expect(screen.getByText(/Settings for Acme Corp/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename" }).hasAttribute("disabled")).toBe(true);
  });

  it("moves the domain-join switch at once and keeps it once saved", async () => {
    let allow = false;
    let release: () => void = () => {};
    const seen = mockFetch({
      [`GET ${PATH}`]: () =>
        jsonResponse(settings({ organization: { id: "o", name: "Acme", allowDomainJoin: allow } })),
      [`PATCH ${PATH}`]: async (request) => {
        await new Promise<void>((resolve) => (release = resolve));
        allow = (request.body as { allowDomainJoin: boolean }).allowDomainJoin;
        return jsonResponse({ ok: true });
      },
    });
    renderView();
    await waitFor(() => expect(domainJoin().getAttribute("aria-checked")).toBe("false"));

    await userEvent.click(domainJoin());
    // Before the server answers: on, and held until the change settles.
    expect(domainJoin().getAttribute("aria-checked")).toBe("true");
    expect(domainJoin().hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(seen.some((r) => r.method === "PATCH")).toBe(true));
    expect(seen.find((r) => r.method === "PATCH")!.body).toEqual({ allowDomainJoin: true });

    release();
    await waitFor(() =>
      expect(toasts.toast).toHaveBeenCalledWith("Anyone with a matching email can join"),
    );
    await waitFor(() => expect(domainJoin().hasAttribute("disabled")).toBe(false));
    expect(domainJoin().getAttribute("aria-checked")).toBe("true");
  });

  it("rolls the domain-join switch back with the server's error", async () => {
    let release: () => void = () => {};
    mockFetch({
      [`GET ${PATH}`]: settings(),
      [`PATCH ${PATH}`]: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return jsonResponse({ error: "Add an email domain before allowing people to join." }, 400);
      },
    });
    renderView();
    await waitFor(() => expect(domainJoin().getAttribute("aria-checked")).toBe("false"));
    await userEvent.click(domainJoin());
    expect(domainJoin().getAttribute("aria-checked")).toBe("true");

    release();
    await waitFor(() =>
      expect(toasts.toast).toHaveBeenCalledWith(
        "Add an email domain before allowing people to join.",
        { variant: "danger" },
      ),
    );
    await waitFor(() => expect(domainJoin().getAttribute("aria-checked")).toBe("false"));
  });

  it("shows a new invitation, a removed domain and members joining elsewhere without a reload", async () => {
    let current = settings();
    const seen = mockFetch({
      [`GET ${PATH}`]: () => jsonResponse(current),
      [`POST ${PATH}/invitations`]: (request) => {
        const { email, role } = request.body as { email: string; role: "admin" | "member" };
        current = {
          ...current,
          invitations: [
            {
              id: INVITATION_ID,
              email,
              role,
              createdAt: "2026-10-16T10:00:00.000Z",
              expiresAt: "2026-10-30T10:00:00.000Z",
            },
          ],
        };
        return jsonResponse({ ok: true });
      },
      [`DELETE ${PATH}/domains/acme.io`]: () => {
        current = { ...current, domains: [] };
        return jsonResponse({ ok: true });
      },
    });
    const client = renderView();
    await waitFor(() => expect(screen.getByText("No pending invitations.")).toBeTruthy());

    await userEvent.type(screen.getByLabelText(/^Email/), "new@acme.io");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(screen.getByText("new@acme.io")).toBeTruthy());
    expect(seen.find((r) => r.method === "POST")!.body).toEqual({
      email: "new@acme.io",
      role: "member",
    });
    expect((screen.getByLabelText(/^Email/) as HTMLInputElement).value).toBe("");

    await userEvent.click(screen.getByRole("button", { name: "Remove acme.io" }));
    await waitFor(() =>
      expect(screen.getByText("No domains: anyone can be invited.")).toBeTruthy(),
    );

    // Someone accepted an invitation in another browser.
    current = {
      ...current,
      invitations: [],
      members: [
        ...current.members,
        {
          id: "user-2",
          name: "Bo",
          email: "new@acme.io",
          image: null,
          role: "member",
          joinedAt: "2026-10-16T11:00:00.000Z",
        },
      ],
    };
    await client.invalidateQueries();
    await waitFor(() => expect(screen.getByText("Bo")).toBeTruthy());
    expect(screen.getByText("No pending invitations.")).toBeTruthy();
  });

  it("shows members the settings read-only", async () => {
    mockFetch({ [`GET ${PATH}`]: settings({ isAdmin: false }) });
    renderView("member");
    await waitFor(() => expect(nameField().value).toBe("Acme"));
    expect(nameField().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByText("Invitations")).toBeNull();
    expect(domainJoin().hasAttribute("disabled")).toBe(true);
  });
});
