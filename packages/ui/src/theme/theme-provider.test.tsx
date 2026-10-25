import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREFERS_LIGHT_QUERY, type ThemePreference } from "./resolve.js";
import { ThemeProvider, useTheme } from "./theme-provider.js";

/** A controllable `prefers-color-scheme: light` media query. */
function installMatchMedia(initiallyLight: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initiallyLight,
    media: PREFERS_LIGHT_QUERY,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  const matchMedia = vi.fn((media: string) => {
    expect(media).toBe(PREFERS_LIGHT_QUERY);
    return query as unknown as MediaQueryList;
  });
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    listenerCount: () => listeners.size,
    setLight(light: boolean) {
      query.matches = light;
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

function Probe() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <div>
      <output aria-label="preference">{preference}</output>
      <output aria-label="resolved">{resolved}</output>
      {(["system", "dark", "light"] as const).map((option) => (
        <button key={option} type="button" onClick={() => setPreference(option)}>
          {option}
        </button>
      ))}
    </div>
  );
}

const theme = () => document.documentElement.dataset.theme;

beforeEach(() => {
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ThemeProvider", () => {
  it.each<[ThemePreference, boolean, string]>([
    ["dark", true, "dark"],
    ["light", false, "light"],
    ["system", true, "light"],
    ["system", false, "dark"],
  ])("applies %s (OS prefers light: %s) as data-theme=%s", (preference, light, expected) => {
    installMatchMedia(light);
    render(
      <ThemeProvider preference={preference}>
        <Probe />
      </ThemeProvider>,
    );
    expect(theme()).toBe(expected);
    expect(screen.getByLabelText("resolved").textContent).toBe(expected);
    expect(screen.getByLabelText("preference").textContent).toBe(preference);
  });

  it("follows prefers-color-scheme changes while on system", () => {
    const media = installMatchMedia(false);
    render(
      <ThemeProvider preference="system">
        <Probe />
      </ThemeProvider>,
    );
    expect(theme()).toBe("dark");
    media.setLight(true);
    expect(theme()).toBe("light");
    media.setLight(false);
    expect(theme()).toBe("dark");
  });

  it("ignores prefers-color-scheme changes while on dark", () => {
    const media = installMatchMedia(false);
    render(
      <ThemeProvider preference="dark">
        <Probe />
      </ThemeProvider>,
    );
    expect(media.listenerCount()).toBe(0);
    media.setLight(true);
    expect(theme()).toBe("dark");
  });

  it("calls onPreferenceChange once per change and applies the new theme", async () => {
    installMatchMedia(true);
    const onPreferenceChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ThemeProvider preference="dark" onPreferenceChange={onPreferenceChange}>
        <Probe />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "light" }));
    expect(onPreferenceChange).toHaveBeenCalledTimes(1);
    expect(onPreferenceChange).toHaveBeenLastCalledWith("light");
    expect(theme()).toBe("light");

    // Choosing the current preference again is not a change.
    await user.click(screen.getByRole("button", { name: "light" }));
    expect(onPreferenceChange).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "system" }));
    expect(onPreferenceChange).toHaveBeenCalledTimes(2);
    expect(onPreferenceChange).toHaveBeenLastCalledWith("system");
    expect(screen.getByLabelText("preference").textContent).toBe("system");
    expect(theme()).toBe("light");
  });

  it("takes a new saved preference from its props", () => {
    installMatchMedia(false);
    const { rerender } = render(
      <ThemeProvider preference="light">
        <Probe />
      </ThemeProvider>,
    );
    expect(theme()).toBe("light");
    rerender(
      <ThemeProvider preference="dark">
        <Probe />
      </ThemeProvider>,
    );
    expect(theme()).toBe("dark");
  });

  it("falls back to dark for system when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(
      <ThemeProvider preference="system">
        <Probe />
      </ThemeProvider>,
    );
    expect(theme()).toBe("dark");
  });
});

describe("useTheme", () => {
  it("requires a ThemeProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow("useTheme must be used inside a ThemeProvider.");
  });
});
