// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iamthemcmaster/ui";
import { toast } from "@omniralph/ui";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { testUser } from "@/components/query-test-utils";
import { useUnsavedChanges } from "@/components/unsaved-changes";
import { LegacyFrame } from "./legacy-frame";

// Today's pages inside the 2.0 shell, composed as `(app)/layout.tsx` does: the breadcrumbs,
// the library's tooltips, the unsaved-changes guard and bar, and the shell's toasts all work.

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

function TodaysPage() {
  useUnsavedChanges("Routing rules", "settings-routing-rules", true);
  return (
    <>
      <AppHeader
        breadcrumbs={[{ label: "Settings", href: "/settings/organization" }, { label: "Routing" }]}
      />
      <section id="settings-routing-rules">
        <Tooltip>
          <TooltipTrigger>Rule help</TooltipTrigger>
          <TooltipContent>Rules run top to bottom</TooltipContent>
        </Tooltip>
        <button type="button" onClick={() => toast("Routing saved")}>
          Save routing
        </button>
      </section>
    </>
  );
}

function renderTodaysPage() {
  return render(
    <AppShell user={testUser} themePreference="dark" organizationCookie={null} scopeCookie={null}>
      <LegacyFrame>
        <TodaysPage />
      </LegacyFrame>
    </AppShell>,
  );
}

beforeEach(() => {
  nav.router.push.mockReset();
  nav.router.refresh.mockReset();
});

describe("today's pages inside the 2.0 shell", () => {
  it("show their breadcrumbs and unsaved-changes bar in the frame's main", () => {
    renderTodaysPage();
    const main = screen.getByRole("main");
    const crumbs = within(main).getByRole("navigation", { name: "breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
      "/settings/organization",
    );
    const bar = main.querySelector<HTMLElement>(".unsaved-bar")!;
    expect(bar.textContent).toContain("1 card has unsaved changes");
    expect(within(bar).getByRole("link", { name: "Routing rules" })).toBeTruthy();
  });

  it("keep the library's tooltips working", async () => {
    renderTodaysPage();
    const user = userEvent.setup();
    await user.hover(screen.getByRole("button", { name: "Rule help" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Rules run top to bottom");
  });

  it("show their toasts in the shell's toaster", async () => {
    renderTodaysPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save routing" }));
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(within(region).getByRole("status").textContent).toBe("Routing saved");
    act(() => within(region).getByRole("button", { name: "Dismiss" }).click());
  });

  it("ask before a shell nav link leaves unsaved changes", async () => {
    renderTodaysPage();
    const user = userEvent.setup();
    const sidebar = screen.getAllByRole("navigation", { name: "Primary" })[0]!;
    await user.click(within(sidebar).getByRole("link", { name: "Repos" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Leave without saving?" });
    expect(nav.router.push).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Discard and leave" }));
    expect(nav.router.push).toHaveBeenCalledWith("/repositories");
  });

  it("ask before a phone drawer link leaves unsaved changes", async () => {
    renderTodaysPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(within(drawer).getByRole("link", { name: "Fleet" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Leave without saving?" });
    expect(nav.router.push).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Discard and leave" }));
    expect(nav.router.push).toHaveBeenCalledWith("/harnesses");
  });
});
