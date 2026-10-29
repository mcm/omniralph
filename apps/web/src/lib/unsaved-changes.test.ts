import { describe, expect, it, vi } from "vitest";
import {
  guardedHref,
  installUnsavedGuard,
  unsavedSummary,
  type GuardAnchor,
} from "./unsaved-changes";

const HERE = "https://panel.example/repositories/r1/settings";
const plainClick = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};

function anchor(href: string, attrs: { target?: string; download?: boolean } = {}): GuardAnchor {
  return {
    href: new URL(href, HERE).href,
    target: attrs.target ?? "",
    hasAttribute: (name) => name === "download" && Boolean(attrs.download),
  };
}

describe("unsavedSummary", () => {
  it("counts the cards", () => {
    expect(unsavedSummary(1)).toBe("1 card has unsaved changes");
    expect(unsavedSummary(3)).toBe("3 cards have unsaved changes");
  });
});

describe("guardedHref", () => {
  it("returns the in-app destination of a plain click", () => {
    expect(guardedHref(plainClick, anchor("/runs/1?step=s1#finding-1"), HERE)).toBe(
      "/runs/1?step=s1#finding-1",
    );
  });

  it("lets new tabs, downloads, other sites and same-page links through", () => {
    expect(guardedHref({ ...plainClick, metaKey: true }, anchor("/runs"), HERE)).toBeNull();
    expect(guardedHref({ ...plainClick, button: 1 }, anchor("/runs"), HERE)).toBeNull();
    expect(guardedHref(plainClick, anchor("/runs", { target: "_blank" }), HERE)).toBeNull();
    expect(guardedHref(plainClick, anchor("/export", { download: true }), HERE)).toBeNull();
    expect(guardedHref(plainClick, anchor("https://github.com/x"), HERE)).toBeNull();
    expect(guardedHref(plainClick, anchor("#settings-coding-tools"), HERE)).toBeNull();
    expect(
      guardedHref({ ...plainClick, defaultPrevented: true }, anchor("/runs"), HERE),
    ).toBeNull();
  });
});

function setup(dirty: boolean, href = "/runs") {
  const win = Object.assign(new EventTarget(), { location: { href: HERE } });
  const link = anchor(href);
  const root = Object.assign(new EventTarget(), { closest: () => link });
  const onLeave = vi.fn();
  const uninstall = installUnsavedGuard({ win, root, isDirty: () => dirty, onLeave });
  const click = () => {
    const { defaultPrevented: _, ...modifiers } = plainClick;
    const event = Object.assign(new Event("click", { cancelable: true }), modifiers);
    root.dispatchEvent(event);
    return event;
  };
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    win.dispatchEvent(event);
    return event;
  };
  return { click, unload, onLeave, uninstall };
}

describe("installUnsavedGuard", () => {
  it("stops an in-app link and asks while a card is dirty", () => {
    const { click, onLeave } = setup(true);
    const event = click();
    expect(event.defaultPrevented).toBe(true);
    expect(onLeave).toHaveBeenCalledWith("/runs");
  });

  it("asks the browser to confirm an unload while a card is dirty", () => {
    expect(setup(true).unload().defaultPrevented).toBe(true);
  });

  it("does nothing while every card is saved", () => {
    const { click, unload, onLeave } = setup(false);
    expect(click().defaultPrevented).toBe(false);
    expect(unload().defaultPrevented).toBe(false);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("lets a same-page anchor through even while dirty", () => {
    const { click, onLeave } = setup(true, "#settings-coding-tools");
    expect(click().defaultPrevented).toBe(false);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("stops guarding once uninstalled", () => {
    const { click, unload, onLeave, uninstall } = setup(true);
    uninstall();
    expect(click().defaultPrevented).toBe(false);
    expect(unload().defaultPrevented).toBe(false);
    expect(onLeave).not.toHaveBeenCalled();
  });
});
