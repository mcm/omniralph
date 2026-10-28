// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { clearToasts, Toaster } from "@omniralph/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import { AuthShell } from "@/components/auth-shell";
import { OnboardingView, type InvitationRow } from "./onboarding-view";

vi.mock("next/link", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLinkStatus: () => ({ pending: false }),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const actions = vi.hoisted(() => ({
  acceptInvitationAction: vi.fn<(id: string, organizationId: string) => Promise<ActionResult>>(),
  createOrganizationAction: vi.fn<(name: string) => Promise<ActionResult>>(),
  declineInvitationAction: vi.fn<(id: string) => Promise<ActionResult>>(),
  joinOrganizationAction: vi.fn<(id: string) => Promise<ActionResult>>(),
  switchOrganizationAction: vi.fn<(id: string) => Promise<ActionResult>>(),
}));
vi.mock("./actions", () => actions);
vi.mock("@/lib/auth/actions", () => ({ signOutAction: vi.fn(async () => {}) }));

beforeEach(() => {
  for (const action of Object.values(actions)) action.mockReset().mockResolvedValue({ ok: true });
  router.push.mockReset();
  router.refresh.mockReset();
});
afterEach(() => {
  cleanup();
  act(() => clearToasts());
});

const invitation: InvitationRow = {
  id: "inv-1",
  organizationId: "org-beta",
  organizationName: "Beta",
  role: "member",
  expiresAt: "2026-11-01T00:00:00.000Z",
};

function renderView(props: Partial<React.ComponentProps<typeof OnboardingView>> = {}) {
  return render(
    <>
      <AuthShell>
        <OnboardingView
          hasActiveOrganization={false}
          email="ada@example.com"
          invitations={[]}
          joinable={[]}
          memberships={[]}
          {...props}
        />
      </AuthShell>
      <Toaster />
    </>,
  );
}

describe("OnboardingView", () => {
  it("asks a user without an organization to choose one", () => {
    renderView();
    expect(screen.getByRole("heading", { level: 1, name: "Choose an organization" })).toBeTruthy();
    expect(screen.getByText(/join one you were invited to as ada@example.com/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Back to the control panel" })).toBeNull();
  });

  it("creates an organization and opens it", async () => {
    const user = userEvent.setup();
    renderView();
    const create = screen.getByRole("button", { name: "Create organization" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "  Acme ");
    await user.click(create);
    expect(actions.createOrganizationAction).toHaveBeenCalledWith("Acme");
    expect((await screen.findByRole("status")).textContent).toBe("Created Acme");
    expect(router.push).toHaveBeenCalledWith("/");
  });

  it("shows a failed create in an alert and stays", async () => {
    actions.createOrganizationAction.mockResolvedValue({
      ok: false,
      error: "An organization named Acme already exists.",
    });
    const user = userEvent.setup();
    renderView();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Acme");
    await user.click(screen.getByRole("button", { name: "Create organization" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "An organization named Acme already exists.",
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("accepts an invitation and opens the organization", async () => {
    const user = userEvent.setup();
    renderView({ invitations: [invitation] });
    const list = screen.getByRole("list", { name: "Invitations" });
    expect(within(list).getByText("Beta")).toBeTruthy();
    await user.click(within(list).getByRole("button", { name: "Accept" }));
    expect(actions.acceptInvitationAction).toHaveBeenCalledWith("inv-1", "org-beta");
    expect((await screen.findByRole("status")).textContent).toBe("Joined Beta");
    expect(router.push).toHaveBeenCalledWith("/");
  });

  it("declines an invitation and refreshes the page", async () => {
    const user = userEvent.setup();
    renderView({ invitations: [invitation] });
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(actions.declineInvitationAction).toHaveBeenCalledWith("inv-1");
    expect((await screen.findByRole("status")).textContent).toBe("Declined Beta");
    expect(router.refresh).toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("joins an organization open to the email domain", async () => {
    const user = userEvent.setup();
    renderView({ joinable: [{ id: "org-gamma", name: "Gamma" }] });
    const list = screen.getByRole("list", { name: "Organizations you can join" });
    await user.click(within(list).getByRole("button", { name: "Join" }));
    expect(actions.joinOrganizationAction).toHaveBeenCalledWith("org-gamma");
    expect((await screen.findByRole("status")).textContent).toBe("Joined Gamma");
  });

  it("opens an organization the user belongs to, and leads back to the control panel", async () => {
    const user = userEvent.setup();
    renderView({
      hasActiveOrganization: true,
      memberships: [{ id: "org-acme", name: "Acme", role: "admin" }],
    });
    expect(screen.getByRole("heading", { level: 1, name: "Organizations" })).toBeTruthy();
    const list = screen.getByRole("list", { name: "Your organizations" });
    expect(within(list).getByText("Admin")).toBeTruthy();
    await user.click(within(list).getByRole("button", { name: "Open" }));
    expect(actions.switchOrganizationAction).toHaveBeenCalledWith("org-acme");
    expect(
      screen.getByRole("link", { name: "Back to the control panel" }).getAttribute("href"),
    ).toBe("/");
  });
});
