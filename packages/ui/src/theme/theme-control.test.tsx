import { act, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemePreference } from "./resolve.js";
import { ThemeControl } from "./theme-control.js";
import { ThemeProvider } from "./theme-provider.js";

const theme = () => document.documentElement.dataset.theme;

function renderControl(
  preference: ThemePreference,
  onPreferenceChange?: (next: ThemePreference) => void | Promise<unknown>,
) {
  render(
    <ThemeProvider preference={preference} onPreferenceChange={onPreferenceChange}>
      <ThemeControl />
    </ThemeProvider>,
  );
  return screen.getByRole("radiogroup", { name: "Theme" });
}

const radio = (name: string) => screen.getByRole("radio", { name });

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  vi.stubGlobal("matchMedia", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThemeControl", () => {
  it("offers System, Dark and Light with the saved preference selected", () => {
    renderControl("light");
    expect(screen.getAllByRole("radio").map((option) => option.textContent)).toEqual([
      "System",
      "Dark",
      "Light",
    ]);
    expect(radio("Light").getAttribute("aria-checked")).toBe("true");
    expect(radio("Dark").getAttribute("aria-checked")).toBe("false");
  });

  it("applies a clicked choice at once and reports it once", async () => {
    const user = userEvent.setup();
    const onPreferenceChange = vi.fn();
    renderControl("dark", onPreferenceChange);
    await user.click(radio("Light"));
    expect(theme()).toBe("light");
    expect(radio("Light").getAttribute("aria-checked")).toBe("true");
    expect(onPreferenceChange).toHaveBeenCalledTimes(1);
    expect(onPreferenceChange).toHaveBeenCalledWith("light");
  });

  it("moves and selects with the arrow keys from its one tab stop", async () => {
    const user = userEvent.setup();
    const onPreferenceChange = vi.fn();
    renderControl("system", onPreferenceChange);
    await user.tab();
    expect(document.activeElement).toBe(radio("System"));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(radio("Dark"));
    expect(theme()).toBe("dark");
    await user.keyboard("{End}");
    expect(theme()).toBe("light");
    await user.keyboard("{ArrowRight}");
    expect(radio("System").getAttribute("aria-checked")).toBe("true");
    expect(onPreferenceChange.mock.calls.map(([value]) => value)).toEqual([
      "dark",
      "light",
      "system",
    ]);
  });

  it("restores the previous choice when saving it fails", async () => {
    const user = userEvent.setup();
    let fail!: () => void;
    renderControl(
      "dark",
      () =>
        new Promise((_, reject) => {
          fail = () => reject(new Error("offline"));
        }),
    );
    await user.click(radio("Light"));
    expect(theme()).toBe("light");
    await act(async () => fail());
    expect(theme()).toBe("dark");
    expect(radio("Dark").getAttribute("aria-checked")).toBe("true");
  });
});
