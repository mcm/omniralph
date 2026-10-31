// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { toast } from "@omniralph/ui";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";
import { testUser } from "@/components/query-test-utils";
import { useUnsavedChanges } from "@/components/unsaved-changes";
import { PageFrame } from "./page-frame";

// A page inside the shell, composed as `(app)/layout.tsx` does: the unsaved-changes guard and
// bar, and the shell's toasts all work.

const nav = vi.hoisted(() => ({ router: { push: vi.fn(), refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/routing",
  useRouter: () => nav.router,
}));
vi.mock("next/link", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLinkStatus: () => ({ pending: false }),
}));
vi.mock("@/lib/theme-actions", () => ({ saveThemePreference: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/auth/actions", () => ({ signOutAction: vi.fn(async () => {}) }));

function RoutingPage() {
  useUnsavedChanges("Routing rules", "settings-routing-rules", true);
  return (
    <section id="settings-routing-rules">
      <button type="button" onClick={() => toast("Routing saved")}>
        Save routing
      </button>
    </section>
  );
}

function renderPage() {
  return render(
    <AppShell
      user={testUser}
      themePreference="dark"
      organizationCookie={null}
      scopeCookie={null}
      showAdvanced={false}
      sound={{ enabled: true, volume: 0.7 }}
    >
      <PageFrame>
        <RoutingPage />
      </PageFrame>
    </AppShell>,
  );
}

beforeEach(() => {
  nav.router.push.mockReset();
  nav.router.refresh.mockReset();
});

describe("a page inside the shell", () => {
  it("shows its unsaved-changes bar in the frame's main", () => {
    renderPage();
    const main = screen.getByRole("main");
    const bar = main.querySelector<HTMLElement>(".unsaved-bar")!;
    expect(bar.textContent).toContain("1 card has unsaved changes");
    expect(within(bar).getByRole("link", { name: "Routing rules" })).toBeTruthy();
  });

  it("shows its toasts in the shell's toaster", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save routing" }));
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(within(region).getByRole("status").textContent).toBe("Routing saved");
    act(() => within(region).getByRole("button", { name: "Dismiss" }).click());
  });

  it("asks before a shell nav link leaves unsaved changes", async () => {
    renderPage();
    const user = userEvent.setup();
    const sidebar = screen.getAllByRole("navigation", { name: "Primary" })[0]!;
    await user.click(within(sidebar).getByRole("link", { name: "Repos" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Leave without saving?" });
    expect(nav.router.push).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Discard and leave" }));
    expect(nav.router.push).toHaveBeenCalledWith("/repos");
  });

  it("asks before a phone drawer link leaves unsaved changes", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(within(drawer).getByRole("link", { name: "Fleet" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Leave without saving?" });
    expect(nav.router.push).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Discard and leave" }));
    expect(nav.router.push).toHaveBeenCalledWith("/fleet");
  });
});
