// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeKeyboardWalk,
  keyboardInPage,
  landmarksInPage,
  overlaysInPage,
  walkKeyboard,
} from "./a11y-page.mjs";

/** Focus rings for the fixtures: jsdom has no default focus style. */
const STYLE = "<style>.ring:focus { box-shadow: 0 0 0 2px blue; }</style>";

function render(html: string) {
  document.body.innerHTML = STYLE + html;
}

afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * Tab as a browser does it: the focused element's keydown first (a focus trap cancels it),
 * then the next element in the tab order, or out of the document after the last one.
 */
function pressTab() {
  const from = (document.activeElement ?? document.body) as HTMLElement;
  const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  if (!from.dispatchEvent(event)) return;
  const order = [...document.querySelectorAll<HTMLElement>("*")].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !(element as HTMLButtonElement).disabled &&
      !element.closest("[hidden]") &&
      getComputedStyle(element).display !== "none",
  );
  const next =
    from === document.body
      ? order[0]
      : order.find(
          (element) =>
            from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING &&
            !from.contains(element),
        );
  if (next) next.focus();
  else from.blur();
}

async function walk() {
  const required = keyboardInPage({ action: "prepare" });
  const result = await walkKeyboard({
    press: async () => pressTab(),
    state: async () => keyboardInPage({ action: "state" }),
  });
  keyboardInPage({ action: "cleanup" });
  return { ...result, findings: analyzeKeyboardWalk({ required, ...result }) };
}

describe("the keyboard walk", () => {
  it("passes a page whose controls all take the focus with a ring", async () => {
    render(`
      <a class="ring" href="/runs">Runs</a>
      <button class="ring">Save</button>
      <input class="ring" aria-label="Name">
      <button class="ring" disabled>Disabled</button>
      <button class="ring" style="display: none">Hidden</button>`);
    const { stops, cycled, findings } = await walk();
    expect(stops.map((stop) => stop.target)).toEqual([
      'a.ring "Runs"',
      'button.ring "Save"',
      'input.ring "Name"',
    ]);
    expect(cycled).toBe(true);
    expect(findings).toEqual([]);
    expect(document.querySelector("[data-a11y-start]")).toBeNull();
  });

  it("reports a button Tab never reaches", async () => {
    render(`<button class="ring">Save</button><button class="ring" tabindex="-1">Delete</button>`);
    const { findings } = await walk();
    expect(findings).toEqual([
      {
        rule: "unreachable",
        target: 'button.ring "Delete"',
        summary: "Tab never reaches this control",
      },
    ]);
  });

  it("counts a roving composite as reached once one member is", async () => {
    render(`
      <div role="tablist">
        <button class="ring" role="tab" tabindex="0">Inbox</button>
        <button class="ring" role="tab" tabindex="-1">Problems</button>
      </div>`);
    expect((await walk()).findings).toEqual([]);
  });

  it("reports a focused element whose focus styles don't change", async () => {
    render(`<button class="ring">Save</button><button>Bare</button>`);
    const { findings } = await walk();
    expect(findings).toEqual([
      {
        rule: "no-focus-indicator",
        target: 'button "Bare"',
        summary: "Its outline and box-shadow don't change when it has the focus",
      },
    ]);
  });

  it("reports a focus trap outside a modal, and what it keeps out of reach", async () => {
    render(`
      <button class="ring">Before</button>
      <div id="trap">
        <button class="ring">One</button>
        <button class="ring">Two</button>
      </div>
      <button class="ring">After</button>`);
    trapFocus(document.getElementById("trap")!);
    const { cycled, findings } = await walk();
    expect(cycled).toBe(false);
    expect(findings).toEqual([
      {
        rule: "unreachable",
        target: 'button.ring "After"',
        summary: "Tab never reaches this control",
      },
      {
        rule: "trap",
        target: 'button.ring "One"',
        summary:
          'The focus cycles through 2 element(s) and never leaves: button.ring "One", button.ring "Two"',
      },
    ]);
  });

  it("lets an open modal hold the focus, and only requires what it holds", async () => {
    render(`
      <button class="ring">Behind</button>
      <div id="dialog" role="dialog" aria-modal="true">
        <button class="ring">Cancel</button>
        <button class="ring">Revoke</button>
      </div>`);
    const dialog = document.getElementById("dialog")!;
    trapFocus(dialog);
    dialog.querySelector("button")!.focus();
    // A modal's focus scope pulls the focus back when something outside takes it.
    document.addEventListener("focusin", (event) => {
      if (!dialog.contains(event.target as Node)) dialog.querySelector("button")!.focus();
    });
    const { findings } = await walk();
    expect(findings).toEqual([]);
  });
});

/** Tab and Shift+Tab cycle inside `region`: a focus trap. */
function trapFocus(region: HTMLElement) {
  region.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const buttons = [...region.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + 1) % buttons.length]!.focus();
  });
}

describe("landmarksInPage", () => {
  it("passes one main and an h1", () => {
    render(`<nav><a href="/">Inbox</a></nav><main><h1>Inbox</h1></main>`);
    expect(landmarksInPage({ navNames: true })).toEqual([]);
  });

  it("reports no main, no h1 and unnamed navigation links", () => {
    render(`<nav><a href="/runs"><svg aria-hidden="true"></svg></a></nav><div><h2>Runs</h2></div>`);
    expect(landmarksInPage({ navNames: true }).map((finding) => finding.rule)).toEqual([
      "no-main",
      "no-h1",
      "unnamed-nav-link",
    ]);
    // Only checked at the icon rail.
    expect(landmarksInPage({ navNames: false }).map((finding) => finding.rule)).toEqual([
      "no-main",
      "no-h1",
    ]);
  });

  it("skips the main and h1 while a modal hides the page", () => {
    render(
      `<main aria-hidden="true"><h1>Fleet</h1></main><div role="dialog" aria-modal="true"></div>`,
    );
    expect(landmarksInPage()).toEqual([]);
  });

  it("reports more than one main, and skips hidden ones", () => {
    render(`<main><h1>A</h1></main><div role="main"></div><main hidden></main>`);
    expect(landmarksInPage().map((finding) => finding.rule)).toEqual(["many-main"]);
  });
});

describe("overlaysInPage", () => {
  it("lists the outermost open overlays and whether the focus went back to the opener", () => {
    render(`
      <button data-a11y-opener="0">More actions</button>
      <div role="menu" aria-label="Actions"><div role="listbox"></div></div>
      <div role="dialog" hidden></div>`);
    const overlays = overlaysInPage({ action: "list" });
    expect(overlays).toEqual([{ key: "o0", target: 'div "Actions"' }]);
    document.querySelector("[role=menu]")!.remove();
    expect(overlaysInPage({ action: "open", keys: ["o0"] })).toEqual([]);
    document.querySelector("button")!.focus();
    expect(overlaysInPage({ action: "focus" })).toEqual({
      opener: 'button "More actions"',
      focused: 'button "More actions"',
      returned: true,
    });
  });
});
