// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as OmniralphUi from "@omniralph/ui";
import { AppFrame, PREFERS_LIGHT_QUERY, type ThemePreference } from "@omniralph/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import { CurrentUserProvider } from "./current-user";
import { testUser } from "./query-test-utils";
import { SavedThemeProvider, THEME_SAVE_FAILED } from "./saved-theme";
import { UserMenu } from "./user-menu";

const actions = vi.hoisted(() => ({
  saveThemePreference: vi.fn<(preference: string) => Promise<ActionResult>>(),
  signOutAction: vi.fn(async () => {}),
  toast: vi.fn(),
}));
vi.mock("@/lib/theme-actions", () => ({ saveThemePreference: actions.saveThemePreference }));
vi.mock("@/lib/auth/actions", () => ({ signOutAction: actions.signOutAction }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: actions.toast,
}));

/** A controllable `prefers-color-scheme: light`; every other query never matches. */
function installMatchMedia(light: boolean) {
  const listeners = new Set<() => void>();
  const scheme = {
    get matches() {
      return light;
    },
    media: PREFERS_LIGHT_QUERY,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", (media: string) =>
    media === PREFERS_LIGHT_QUERY
      ? scheme
      : { matches: false, media, addEventListener() {}, removeEventListener() {} },
  );
  return {
    setLight(next: boolean) {
      light = next;
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

function renderShell(preference: ThemePreference) {
  render(
    <SavedThemeProvider preference={preference}>
      <CurrentUserProvider user={testUser}>
        <AppFrame
          currentPath="/coding"
          brandHref="/"
          nav={[]}
          user={{ name: "Ada", initials: "A" }}
          userMenu={(trigger) => <UserMenu trigger={trigger} />}
        />
      </CurrentUserProvider>
    </SavedThemeProvider>,
  );
}

const sidebarFooter = () =>
  within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", {
    name: "Ada",
  });
const phoneAvatar = () => within(screen.getByRole("banner")).getByRole("button", { name: "Ada" });
const theme = () => document.documentElement.getAttribute("data-theme");
const option = (name: string) =>
  within(screen.getByRole("radiogroup", { name: "Theme" })).getByRole("radio", { name });

async function openFrom(trigger: HTMLElement) {
  const user = userEvent.setup();
  await user.click(trigger);
  const menu = await screen.findByRole("menu");
  return { user, menu };
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  actions.saveThemePreference.mockReset().mockResolvedValue({ ok: true });
  actions.signOutAction.mockClear();
  actions.toast.mockReset();
  installMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UserMenu", () => {
  it.each([
    ["the sidebar footer", sidebarFooter],
    ["the phone avatar", phoneAvatar],
  ])("opens from %s with the user, the theme and Sign out", async (_, trigger) => {
    renderShell("dark");
    const { menu } = await openFrom(trigger());
    expect(within(menu).getByText("Ada")).toBeTruthy();
    expect(within(menu).getByText("ada@example.com")).toBeTruthy();
    expect(within(menu).getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });

  it("shows the saved preference", async () => {
    renderShell("system");
    await openFrom(sidebarFooter());
    expect(option("System").getAttribute("aria-checked")).toBe("true");
    expect(option("Dark").getAttribute("aria-checked")).toBe("false");
    expect(option("Light").getAttribute("aria-checked")).toBe("false");
  });

  it("applies Light at once and saves it once", async () => {
    let finish!: (result: ActionResult) => void;
    actions.saveThemePreference.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderShell("dark");
    expect(theme()).toBe("dark");
    const { user } = await openFrom(sidebarFooter());
    await user.click(option("Light"));
    // Applied before the save resolves.
    expect(theme()).toBe("light");
    expect(option("Light").getAttribute("aria-checked")).toBe("true");
    expect(actions.saveThemePreference).toHaveBeenCalledTimes(1);
    expect(actions.saveThemePreference).toHaveBeenCalledWith("light");
    await act(async () => finish({ ok: true }));
    expect(theme()).toBe("light");
    expect(actions.toast).not.toHaveBeenCalled();
    // The menu stays open for another choice.
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("chooses with the keyboard inside the menu", async () => {
    renderShell("dark");
    const user = userEvent.setup();
    sidebarFooter().focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Sign out" }));
    await user.tab();
    expect(document.activeElement).toBe(option("Dark"));
    await user.keyboard("{ArrowRight}");
    expect(theme()).toBe("light");
    expect(actions.saveThemePreference).toHaveBeenLastCalledWith("light");
  });

  it("follows the OS with System, as it changes", async () => {
    const media = installMatchMedia(true);
    renderShell("dark");
    const { user } = await openFrom(phoneAvatar());
    await user.click(option("System"));
    expect(theme()).toBe("light");
    expect(actions.saveThemePreference).toHaveBeenCalledWith("system");
    media.setLight(false);
    expect(theme()).toBe("dark");
    media.setLight(true);
    expect(theme()).toBe("light");
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("offline"))],
    ["is refused", () => Promise.resolve({ ok: false as const, error: "Unknown theme." })],
  ])("restores the previous theme and shows the toast when the save %s", async (_, save) => {
    actions.saveThemePreference.mockImplementation(save);
    renderShell("dark");
    const { user } = await openFrom(sidebarFooter());
    await user.click(option("Light"));
    await waitFor(() => expect(theme()).toBe("dark"));
    expect(option("Dark").getAttribute("aria-checked")).toBe("true");
    expect(actions.toast).toHaveBeenCalledTimes(1);
    expect(actions.toast).toHaveBeenCalledWith(THEME_SAVE_FAILED, { variant: "danger" });
  });

  it("signs out", async () => {
    renderShell("dark");
    const { user } = await openFrom(phoneAvatar());
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(actions.signOutAction).toHaveBeenCalledTimes(1);
  });
});
