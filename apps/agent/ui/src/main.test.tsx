// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { toast } from "@omniralph/ui";
import { act, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "./theme.js";
import { agentState, fakeApi, renderAgentPage } from "./test/page.js";

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

describe("index.html", () => {
  const html = source("../index.html");

  it("loads one module script and has no inline script or style, so the CSP holds", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]![1]).toMatch(/\btype="module"/);
    expect(scripts[0]![1]).toMatch(/\bsrc="\.\/src\/main\.tsx"/);
    expect(scripts[0]![2]!.trim()).toBe("");
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});

describe("main.tsx", () => {
  it("imports the fonts and the styles", () => {
    const main = source("./main.tsx");
    expect(main).toContain('import "@omniralph/ui/fonts.css";');
    expect(main).toContain('import "@omniralph/ui/styles.css";');
    expect(main).toContain('import "./styles.css";');
  });

  it("renders the page with its toaster", async () => {
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage();
    expect(await screen.findByText("build-01")).toBeTruthy();
    act(() => {
      toast("Saved");
    });
    expect(
      within(screen.getByRole("region", { name: "Notifications" })).getByText("Saved"),
    ).toBeTruthy();
  });
});

describe("the theme", () => {
  const selected = () =>
    within(screen.getByRole("radiogroup", { name: "Theme" }))
      .getAllByRole("radio")
      .find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent;

  it("is System when nothing is saved", () => {
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage();
    expect(selected()).toBe("System");
  });

  it("reads the saved preference from localStorage", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage();
    expect(selected()).toBe("Light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("ignores a saved value that isn't a preference", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage();
    expect(selected()).toBe("System");
  });

  it("saves a choice and applies it at once", async () => {
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage();
    await userEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to System and still applies a choice when storage refuses access", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage();
    expect(selected()).toBe("System");
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(selected()).toBe("Dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
