import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ariaKeyShortcuts,
  formatShortcut,
  isApplePlatform,
  isEditableTarget,
  isModalOpen,
  matchesShortcut,
} from "./definitions.js";

const press = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("matchesShortcut", () => {
  it("reads Mod as ⌘ on Apple platforms and Ctrl elsewhere, with no other modifier", () => {
    const search = { key: "k", mod: true } as const;
    expect(matchesShortcut(press({ key: "k", metaKey: true }), search, "apple")).toBe(true);
    expect(matchesShortcut(press({ key: "K", ctrlKey: true }), search, "other")).toBe(true);
    expect(matchesShortcut(press({ key: "k", ctrlKey: true }), search, "apple")).toBe(false);
    expect(matchesShortcut(press({ key: "k", metaKey: true }), search, "other")).toBe(false);
    expect(
      matchesShortcut(press({ key: "k", metaKey: true, ctrlKey: true }), search, "apple"),
    ).toBe(false);
    expect(
      matchesShortcut(press({ key: "k", ctrlKey: true, shiftKey: true }), search, "other"),
    ).toBe(false);
    expect(matchesShortcut(press({ key: "k", ctrlKey: true, altKey: true }), search, "other")).toBe(
      false,
    );
    expect(matchesShortcut(press({ key: "k" }), search, "other")).toBe(false);
  });

  it("fires a plain letter or digit only with no modifier, Shift included", () => {
    for (const key of ["j", "1"]) {
      const definition = { key };
      expect(matchesShortcut(press({ key }), definition, "other")).toBe(true);
      for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"] as const) {
        expect(matchesShortcut(press({ key, [modifier]: true }), definition, "other")).toBe(false);
      }
    }
    // Caps Lock gives "J" without Shift.
    expect(matchesShortcut(press({ key: "J" }), { key: "j" }, "other")).toBe(true);
    expect(matchesShortcut(press({ key: "k" }), { key: "j" }, "other")).toBe(false);
  });

  it("lets a symbol typed with Shift match, but no chord", () => {
    expect(matchesShortcut(press({ key: "?", shiftKey: true }), { key: "?" }, "other")).toBe(true);
    expect(matchesShortcut(press({ key: "?", ctrlKey: true }), { key: "?" }, "other")).toBe(false);
  });

  it("matches Escape by name, including the legacy Esc", () => {
    expect(matchesShortcut(press({ key: "Escape" }), { key: "Escape" }, "apple")).toBe(true);
    expect(matchesShortcut(press({ key: "Esc" }), { key: "Escape" }, "apple")).toBe(true);
  });
});

describe("isEditableTarget", () => {
  const element = (html: string) => {
    document.body.innerHTML = html;
    return document.body.querySelector("[data-target]") ?? document.body.firstElementChild;
  };

  it("is true for text fields and text roles", () => {
    for (const html of [
      "<input>",
      '<input type="email">',
      '<input type="search">',
      "<textarea></textarea>",
      "<select></select>",
      '<div contenteditable="true"><span data-target></span></div>',
      '<div role="textbox"></div>',
      '<div role="searchbox"></div>',
      '<div role="combobox"></div>',
    ]) {
      expect(isEditableTarget(element(html)), html).toBe(true);
    }
  });

  it("is false for controls that take no text, and for plain elements", () => {
    for (const type of ["checkbox", "radio", "button", "submit", "reset", "range", "color"]) {
      expect(isEditableTarget(element(`<input type="${type}">`)), type).toBe(false);
    }
    expect(isEditableTarget(element("<button></button>"))).toBe(false);
    expect(isEditableTarget(element('<div contenteditable="false"></div>'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("isModalOpen", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is true while a dialog, alert dialog, menu, listbox or aria-modal surface shows", () => {
    for (const html of [
      '<div role="dialog"></div>',
      '<div role="alertdialog"></div>',
      '<div role="menu"></div>',
      '<div role="listbox"></div>',
      '<div aria-modal="true"></div>',
    ]) {
      document.body.innerHTML = html;
      expect(isModalOpen(document), html).toBe(true);
    }
  });

  it("is false with none, or only hidden or closing ones", () => {
    document.body.innerHTML = '<div role="region"></div>';
    expect(isModalOpen(document)).toBe(false);
    document.body.innerHTML =
      '<div role="dialog" hidden></div><div style="display: none"><div role="menu"></div></div><div role="dialog" data-state="closed"></div>';
    expect(isModalOpen(document)).toBe(false);
  });
});

describe("isApplePlatform", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers the client hint, then navigator.platform", () => {
    vi.stubGlobal("navigator", { userAgentData: { platform: "macOS" }, platform: "Win32" });
    expect(isApplePlatform()).toBe(true);
    vi.stubGlobal("navigator", { userAgentData: { platform: "Windows" }, platform: "MacIntel" });
    expect(isApplePlatform()).toBe(false);
    vi.stubGlobal("navigator", { platform: "iPhone" });
    expect(isApplePlatform()).toBe(true);
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    expect(isApplePlatform()).toBe(false);
  });
});

describe("formatShortcut and ariaKeyShortcuts", () => {
  it("show Mod by platform, Escape as Esc, and keys as typed", () => {
    expect(formatShortcut({ key: "k", mod: true }, "apple")).toBe("⌘K");
    expect(formatShortcut({ key: "k", mod: true }, "other")).toBe("Ctrl+K");
    expect(formatShortcut({ key: "Escape" }, "other")).toBe("Esc");
    expect(formatShortcut({ key: "j" }, "apple")).toBe("j");
    expect(formatShortcut({ key: "?" }, "apple")).toBe("?");
  });

  it("give the ARIA form: Meta or Control, uppercase letters, Shift for a shifted symbol", () => {
    expect(ariaKeyShortcuts({ key: "k", mod: true }, "apple")).toBe("Meta+K");
    expect(ariaKeyShortcuts({ key: "j", mod: true }, "other")).toBe("Control+J");
    expect(ariaKeyShortcuts({ key: "e" }, "other")).toBe("E");
    expect(ariaKeyShortcuts({ key: "1" }, "other")).toBe("1");
    expect(ariaKeyShortcuts({ key: "?" }, "other")).toBe("Shift+?");
    expect(ariaKeyShortcuts({ key: "Escape" }, "other")).toBe("Escape");
  });
});
