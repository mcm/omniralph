// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProfileSettingsPage from "@/app/(app)/settings/profile/page";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  testUser,
} from "@/components/query-test-utils";
import { SavedThemeProvider } from "@/components/saved-theme";
import { ShowAdvancedProvider } from "@/components/show-advanced";
import type { ActionResult } from "@/lib/action-result";
import { SHOW_ADVANCED_DESCRIPTION } from "./profile-settings";
import { SettingsLayoutView } from "./settings-layout-view";
import { organizationSettings } from "./test-fixtures";

const actions = vi.hoisted(() => ({
  saveThemePreference: vi.fn<(preference: string) => Promise<ActionResult>>(),
  saveShowAdvancedPreference: vi.fn<(value: boolean) => Promise<ActionResult>>(),
  toast: vi.fn(),
}));
vi.mock("@/lib/theme-actions", () => actions);
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: actions.toast,
}));

const nav = vi.hoisted(() => ({ pathname: "/settings/profile" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

/** `prefers-color-scheme: light` never matches (System resolves to dark), nor does any other. */
function installMatchMedia() {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }));
}

beforeEach(() => {
  nav.pathname = "/settings/profile";
  actions.saveThemePreference.mockReset().mockResolvedValue({ ok: true });
  actions.saveShowAdvancedPreference.mockReset().mockResolvedValue({ ok: true });
  actions.toast.mockReset();
  installMatchMedia();
  document.documentElement.removeAttribute("data-theme");
  mockFetch({
    "GET /api/ui/connections": { connections: [] },
    "GET /api/ui/organization": () => jsonResponse(organizationSettings()),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const member: SessionUser = {
  ...testUser,
  name: "Ada Lovelace",
  email: "ada@acme.test",
  image: null,
  role: "member",
  organizations: [{ ...testUser.organization, role: "member" }],
};

/** Profile & theme in Settings, inside the shell's saved theme and preferences. */
function renderProfile(options: { user?: SessionUser; showAdvanced?: boolean } = {}) {
  render(
    <SavedThemeProvider preference="system">
      <CurrentUserProvider user={options.user ?? member}>
        <ShowAdvancedProvider initial={options.showAdvanced ?? false}>
          <QueryClientProvider client={createTestQueryClient()}>
            <UiProvider linkComponent={TestLink}>
              <SettingsLayoutView>
                <ProfileSettingsPage />
              </SettingsLayoutView>
            </UiProvider>
          </QueryClientProvider>
        </ShowAdvancedProvider>
      </CurrentUserProvider>
    </SavedThemeProvider>,
  );
}

const profileCard = () => screen.getByRole("region", { name: "Profile" });
const displayCard = () => screen.getByRole("region", { name: "Display" });
const advancedSwitch = () =>
  within(displayCard()).getByRole("switch", { name: "Show advanced settings" });
const advancedGroup = () =>
  within(screen.getByRole("navigation", { name: "Settings" })).queryByRole("list", {
    name: "Advanced",
  });
const theme = () => document.documentElement.getAttribute("data-theme");

describe("Profile & theme", () => {
  it("shows the user's avatar, name and email read-only", () => {
    renderProfile({ user: { ...member, image: "https://avatars.test/ada.png" } });
    expect(
      within(screen.getByRole("region", { name: "Setting" })).getByRole("heading", {
        level: 2,
        name: "Profile & theme",
      }),
    ).toBeTruthy();
    const card = profileCard();
    expect(card.querySelector("img")!.getAttribute("src")).toBe("https://avatars.test/ada.png");
    expect(within(card).getByText("Ada Lovelace")).toBeTruthy();
    expect(within(card).getByText("ada@acme.test")).toBeTruthy();
    // Nothing to edit.
    expect(within(card).queryByRole("textbox")).toBeNull();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("shows initials without an avatar", () => {
    renderProfile();
    expect(profileCard().querySelector(".or-avatar")!.textContent).toBe("AL");
  });

  it("is every member's own (no admin check)", () => {
    renderProfile({ user: member });
    expect(within(displayCard()).getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    expect(advancedSwitch().hasAttribute("disabled")).toBe(false);
  });
});

describe("the theme", () => {
  it("applies a choice at once and saves it once, through the one theme control", async () => {
    renderProfile();
    // The page renders the shell's ThemeControl, and no second theme control.
    expect(screen.getAllByRole("radiogroup", { name: "Theme" })).toHaveLength(1);
    const control = within(displayCard()).getByRole("radiogroup", { name: "Theme" });
    expect(
      within(control)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["System", "Dark", "Light"]);
    expect(theme()).toBe("dark");

    await userEvent.click(within(control).getByRole("radio", { name: "Light" }));
    expect(theme()).toBe("light");
    expect(within(control).getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await waitFor(() => expect(actions.saveThemePreference).toHaveBeenCalledTimes(1));
    expect(actions.saveThemePreference).toHaveBeenCalledWith("light");
  });
});

describe("Show advanced settings", () => {
  it("says what it does", () => {
    renderProfile();
    const toggle = advancedSwitch();
    const description = document.getElementById(toggle.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe(SHOW_ADVANCED_DESCRIPTION);
    expect(SHOW_ADVANCED_DESCRIPTION).toBe(
      "Shows Routing rules, Playbooks and Chat channel overrides in Settings.",
    );
  });

  it("shows and hides the Advanced group at once, before the save answers", async () => {
    actions.saveShowAdvancedPreference.mockReturnValue(new Promise(() => {}));
    renderProfile();
    expect(advancedSwitch().getAttribute("aria-checked")).toBe("false");
    expect(advancedGroup()).toBeNull();

    await userEvent.click(advancedSwitch());
    expect(advancedSwitch().getAttribute("aria-checked")).toBe("true");
    expect(advancedGroup()).not.toBeNull();
    expect(actions.saveShowAdvancedPreference).toHaveBeenLastCalledWith(true);

    await userEvent.click(advancedSwitch());
    expect(advancedSwitch().getAttribute("aria-checked")).toBe("false");
    expect(advancedGroup()).toBeNull();
    expect(actions.saveShowAdvancedPreference).toHaveBeenLastCalledWith(false);
  });

  it("starts on when the user shows advanced settings", () => {
    renderProfile({ showAdvanced: true });
    expect(advancedSwitch().getAttribute("aria-checked")).toBe("true");
    expect(advancedGroup()).not.toBeNull();
  });

  it("reverts with a toast when the save fails", async () => {
    actions.saveShowAdvancedPreference.mockResolvedValue({ ok: false, error: "Nope" });
    renderProfile();
    await userEvent.click(advancedSwitch());
    await waitFor(() =>
      expect(actions.toast).toHaveBeenCalledWith("Couldn't save your preference.", {
        variant: "danger",
      }),
    );
    expect(advancedSwitch().getAttribute("aria-checked")).toBe("false");
    expect(advancedGroup()).toBeNull();
  });
});

describe("the only controls", () => {
  const root = path.resolve(__dirname, "../../..");
  const sources = (dir: string): string[] =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) return sources(relative);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative] : [];
    });
  const files = sources("src");
  const using = (pattern: RegExp) =>
    files.filter((file) => pattern.test(readFileSync(path.join(root, file), "utf8")));

  it("sets Show advanced settings only from Profile & theme", () => {
    // A caller that takes the setter from useShowAdvanced().
    expect(using(/\[\s*\w*\s*,\s*\w+\s*\]\s*=\s*useShowAdvanced\(/)).toEqual([
      "src/screens/settings/profile-settings.tsx",
    ]);
  });

  it("chooses the theme only through @omniralph/ui's ThemeControl", () => {
    expect(using(/<ThemeControl\b/).sort()).toEqual([
      "src/components/user-menu.tsx",
      "src/screens/settings/profile-settings.tsx",
    ]);
    // Nothing else builds its own theme choice.
    expect(using(/THEME_OPTIONS|setPreference\(/)).toEqual([]);
  });
});
