// The accessibility checks capture.mjs runs on each capture (see ../../README.md): the
// keyboard walk, open overlays for the Escape check, and the landmarks. Plain JS, copied into
// the Playwright container next to capture.mjs. The `*InPage` functions run in the page
// (`page.evaluate`), so each is self-contained: it uses nothing from this module's scope.
// a11y-page.test.ts runs them in jsdom against small HTML fixtures.

/** The axe-core tags every capture is checked against (WCAG 2.2 A and AA). */
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** The most Tab presses one walk makes. */
export const MAX_TAB_STOPS = 300;

/**
 * The keyboard walk's side in the page.
 * - `prepare`: marks every focusable element (`data-a11y-key`), records its unfocused focus
 *   styles, and moves the focus to the top of the page (an open modal keeps it). Returns the
 *   elements the walk must reach: visible, enabled interactive elements (inside the open modal,
 *   when there is one), each with its composite widget (`group`), whose members are reached
 *   with the arrow keys once one of them is, and for a menu item its menu's button (`opener`).
 * - `state`: where the focus is now: `{ outside: true }` on the body (or a focus guard), or
 *   the focused element (`target`, and its `selector` and accessible `name`), whether it is
 *   visible, and whether its focus styles differ from its unfocused ones (`indicator`, `null`
 *   when they weren't recorded).
 * - `cleanup`: removes the walk's start marker.
 * `pseudo`: also compare `::before` and `::after` (jsdom can't read them).
 * @param {{ action: "prepare" | "state" | "cleanup", pseudo?: boolean }} options
 * @returns {any} by action: the required elements, the focus state, or `null`
 */
export function keyboardInPage(options) {
  const { action } = options;
  const FOCUSABLE =
    'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [contenteditable=""], [contenteditable="true"], [tabindex]';
  const REQUIRED =
    'a[href], button, input:not([type="hidden"]), select, textarea, [role="switch"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [tabindex="0"]';
  // Roving focus: one member takes Tab, the arrow keys reach the others.
  const COMPOSITE =
    '[role="tablist"], [role="menu"], [role="menubar"], [role="listbox"], [role="radiogroup"], [role="toolbar"], [role="grid"], [role="treegrid"], [role="tree"]';
  // Regions that may hold the focus: Escape leaves them.
  const MODAL =
    '[aria-modal="true"], dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"]';
  const KEY = "data-a11y-key";
  const store = (globalThis.__omniralphA11y ??= { rest: new Map(), next: 0 });

  const visible = (element) => {
    if (element.closest("[inert]")) return false;
    if (typeof element.checkVisibility === "function") {
      const box = element.getBoundingClientRect();
      return element.checkVisibility({ visibilityProperty: true }) && box.width * box.height > 0;
    }
    for (let node = element; node; node = node.parentElement) {
      if (node.hidden) return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  const keyOf = (element) => {
    if (!element.hasAttribute(KEY)) element.setAttribute(KEY, `k${store.next++}`);
    return element.getAttribute(KEY);
  };
  const selectorOf = (element) => {
    let text = element.tagName.toLowerCase();
    if (element.id) text += `#${element.id}`;
    const classes = [...element.classList].slice(0, 2);
    if (classes.length > 0) text += `.${classes.join(".")}`;
    const role = element.getAttribute("role");
    if (role) text += `[role="${role}"]`;
    return text;
  };
  // The accessible name, as far as a walk needs it: aria-labelledby, aria-label, the labels of a
  // form control, its content (alt text and labels of what it holds, minus aria-hidden parts),
  // then placeholder and title.
  const contentText = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE || node.getAttribute("aria-hidden") === "true") {
      return "";
    }
    const label = node.getAttribute("aria-label") ?? (node.tagName === "IMG" ? node.alt : null);
    if (label) return ` ${label} `;
    return [...node.childNodes].map(contentText).join("");
  };
  const squash = (text) => text.replace(/\s+/g, " ").trim();
  const accessibleName = (element) => {
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => (id ? document.getElementById(id) : null))
      .filter(Boolean);
    const candidates = [
      () => labelledBy.map((node) => contentText(node)).join(" "),
      () => element.getAttribute("aria-label") ?? "",
      () => [...(element.labels ?? [])].map((label) => contentText(label)).join(" "),
      () =>
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? ""
          : contentText(element),
      () => element.getAttribute("placeholder") ?? "",
      () => element.getAttribute("title") ?? "",
    ];
    for (const candidate of candidates) {
      const name = squash(candidate());
      if (name) return name;
    }
    return "";
  };
  const describe = (element) => {
    const text = selectorOf(element);
    const name = (element.getAttribute("aria-label") ?? element.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    return name ? `${text} "${name}"` : text;
  };
  const finishTransitions = () => {
    for (const animation of document.getAnimations?.() ?? []) {
      try {
        animation.finish();
      } catch {
        // infinite: leave it
      }
    }
  };
  const focusStyles = (element) => {
    const read = (node, pseudo) => {
      const style = getComputedStyle(node, pseudo);
      return [
        style.outlineStyle,
        style.outlineWidth,
        style.outlineColor,
        style.outlineOffset,
        style.boxShadow,
      ].join(" ");
    };
    const parts = [read(element)];
    if (options.pseudo) parts.push(read(element, "::before"), read(element, "::after"));
    // `:focus-within` rings on the wrapper (e.g. a token field).
    if (element.parentElement) parts.push(read(element.parentElement));
    return parts.join(" | ");
  };
  const openModal = () =>
    [...document.querySelectorAll(MODAL)].filter((element) => visible(element)).at(-1) ?? null;
  const groupOf = (element) => {
    const composite = element.closest(COMPOSITE);
    if (composite) return keyOf(composite);
    if (element instanceof HTMLInputElement && element.type === "radio" && element.name) {
      return `radio:${element.form?.id ?? ""}:${element.name}`;
    }
    return null;
  };
  // A menu's button: Radix names the menu by it (`aria-labelledby`).
  const menuOpenerOf = (element) => {
    const menu = element.closest('[role="menu"]');
    const id = menu?.getAttribute("aria-labelledby");
    const opener = id ? document.getElementById(id) : null;
    return opener ? keyOf(opener) : null;
  };

  if (action === "prepare") {
    store.rest.clear();
    // Unfocused styles need nothing focused (a dialog focuses its first control when it opens).
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    finishTransitions();
    for (const element of document.querySelectorAll(FOCUSABLE)) {
      store.rest.set(keyOf(element), focusStyles(element));
    }
    const modal = openModal();
    const required = [...(modal ?? document).querySelectorAll(REQUIRED)]
      .filter(
        (element) =>
          visible(element) &&
          !element.matches(":disabled") &&
          element.getAttribute("aria-disabled") !== "true" &&
          !element.closest('[aria-hidden="true"]'),
      )
      .map((element) => ({
        key: keyOf(element),
        target: describe(element),
        group: groupOf(element),
        opener: menuOpenerOf(element),
      }));
    const start = document.createElement("span");
    start.tabIndex = -1;
    start.setAttribute("data-a11y-start", "");
    document.body.prepend(start);
    start.focus();
    return required;
  }
  if (action === "cleanup") {
    document.querySelector("[data-a11y-start]")?.remove();
    return null;
  }
  const element = document.activeElement;
  if (
    !element ||
    element === document.body ||
    element === document.documentElement ||
    element.hasAttribute("data-a11y-start") ||
    element.hasAttribute("data-radix-focus-guard")
  ) {
    return { outside: true };
  }
  finishTransitions();
  const key = keyOf(element);
  const rest = store.rest.get(key);
  const controls = ["aria-controls", "aria-owns"]
    .flatMap((name) => (element.getAttribute(name) ?? "").split(/\s+/))
    .map((id) => (id ? document.getElementById(id) : null))
    .filter(Boolean)
    .map((controlled) => keyOf(controlled));
  return {
    outside: false,
    key,
    target: describe(element),
    selector: selectorOf(element),
    name: accessibleName(element),
    visible: visible(element),
    indicator: rest === undefined ? null : focusStyles(element) !== rest,
    inModal: element.closest(MODAL) !== null,
    group: groupOf(element),
    controls,
  };
}

/**
 * Presses Tab from the top of the page until the focus returns to its first stop, or
 * `maxStops` presses; `state` is `keyboardInPage({ action: "state" })`. Three presses in a row that leave
 * the page (the focus on the body) end it too.
 * @param {{ press: () => Promise<void>, state: () => Promise<any>, maxStops?: number }} driver
 */
export async function walkKeyboard({ press, state, maxStops = MAX_TAB_STOPS }) {
  const stops = [];
  let outside = 0;
  for (let presses = 0; presses < maxStops; presses++) {
    await press();
    const stop = await state();
    if (stop.outside) {
      if (++outside >= 3) break;
      continue;
    }
    outside = 0;
    if (stops.length > 0 && stop.key === stops[0].key) return { stops, cycled: true };
    stops.push(stop);
  }
  return { stops, cycled: false };
}

/**
 * The walk's stops as `results.json` records them: each focused element in Tab order, by its
 * selector (`tag#id.class[role]`) and accessible name.
 * @param {{ selector: string, name: string }[]} stops
 * @returns {{ selector: string, name: string }[]}
 */
export function keyboardStops(stops) {
  return stops.map(({ selector, name }) => ({ selector, name }));
}

/**
 * The keyboard walk's findings: required elements the focus never reached (a member of a
 * composite widget counts once any member, or a control of it, was; a menu item once the button
 * that opens its menu was: a menu that isn't modal closes when the focus leaves it, and its
 * button reopens it), focused elements with no
 * visible focus indicator, and a focus trap: the walk never came back to its first stop and
 * kept cycling through elements that aren't all inside an open modal.
 * @param {{ required: { key: string, target: string, group: string | null, opener?: string | null }[], stops: any[], cycled: boolean }} walk
 */
export function analyzeKeyboardWalk({ required, stops, cycled }) {
  const findings = [];
  const reached = new Set(stops.map((stop) => stop.key));
  const reachedGroups = new Set(
    stops.flatMap((stop) => [stop.group, ...(stop.controls ?? [])]).filter(Boolean),
  );
  for (const element of required) {
    if (
      reached.has(element.key) ||
      (element.group && reachedGroups.has(element.group)) ||
      (element.opener && reached.has(element.opener))
    ) {
      continue;
    }
    findings.push({
      rule: "unreachable",
      target: element.target,
      summary: "Tab never reaches this control",
    });
  }
  const reported = new Set();
  for (const stop of stops) {
    if (reported.has(stop.key)) continue;
    if (!stop.visible) {
      reported.add(stop.key);
      findings.push({
        rule: "no-focus-indicator",
        target: stop.target,
        summary: "Takes the focus while hidden",
      });
    } else if (stop.indicator === false) {
      reported.add(stop.key);
      findings.push({
        rule: "no-focus-indicator",
        target: stop.target,
        summary: "Its outline and box-shadow don't change when it has the focus",
      });
    }
  }
  if (!cycled && stops.length > 1) {
    const last = stops.at(-1);
    const previous = stops.slice(0, -1).findLastIndex((stop) => stop.key === last.key);
    const cycle = previous === -1 ? [] : stops.slice(previous + 1);
    if (cycle.length > 0 && !cycle.every((stop) => stop.inModal)) {
      // In the order the walk entered them.
      const keys = new Set(cycle.map((stop) => stop.key));
      const members = [
        ...new Map(
          stops.filter((stop) => keys.has(stop.key)).map((stop) => [stop.key, stop.target]),
        ).values(),
      ];
      findings.push({
        rule: "trap",
        target: members[0],
        summary: `The focus cycles through ${members.length} element(s) and never leaves: ${members.slice(0, 5).join(", ")}`,
      });
    }
  }
  return findings;
}

/**
 * The open overlays (dialogs, sheets, menus, popovers), for the Escape check.
 * - `list`: the visible ones, as `{ key, target }` (keys are `data-a11y-overlay`).
 * - `open`: which of `keys` are still in the page and visible.
 * - `focus`: where the focus is, and whether it is on (or in) the control that opened the
 *   overlay: the last click step's target still in the page (`data-a11y-opener`).
 * @param {{ action: "list" | "open" | "focus", keys?: string[] }} options
 */
export function overlaysInPage({ action, keys = [] }) {
  const OVERLAY =
    'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]';
  const visible = (element) =>
    typeof element.checkVisibility === "function"
      ? element.checkVisibility({ visibilityProperty: true }) && element.getClientRects().length > 0
      : !element.closest("[hidden]");
  const describe = (element) => {
    if (!element || element === document.body) return "the page body";
    const name = (element.getAttribute("aria-label") ?? element.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    const classes = [...element.classList].slice(0, 2);
    const text = `${element.tagName.toLowerCase()}${classes.length ? `.${classes.join(".")}` : ""}`;
    return name ? `${text} "${name}"` : text;
  };
  if (action === "list") {
    let next = document.querySelectorAll("[data-a11y-overlay]").length;
    return [...document.querySelectorAll(OVERLAY)]
      .filter((element) => visible(element) && !element.parentElement?.closest(OVERLAY))
      .map((element) => {
        if (!element.hasAttribute("data-a11y-overlay")) {
          element.setAttribute("data-a11y-overlay", `o${next++}`);
        }
        return { key: element.getAttribute("data-a11y-overlay"), target: describe(element) };
      });
  }
  if (action === "open") {
    return keys.filter((key) => {
      const element = document.querySelector(`[data-a11y-overlay="${key}"]`);
      return element !== null && visible(element);
    });
  }
  const openers = [...document.querySelectorAll("[data-a11y-opener]")].sort(
    (a, b) =>
      Number(a.getAttribute("data-a11y-opener")) - Number(b.getAttribute("data-a11y-opener")),
  );
  const opener = openers.at(-1) ?? null;
  const focused = document.activeElement;
  return {
    opener: opener ? describe(opener) : null,
    focused: describe(focused),
    returned: opener !== null && focused !== null && opener.contains(focused),
  };
}

/**
 * The landmark findings: no `main` landmark or more than one, no level-1 heading, and (with
 * `navNames`, at the icon rail) navigation links whose accessible name is empty. Elements
 * hidden from assistive technology don't count, and while a modal overlay is open (which hides
 * the page behind it) only the navigation links are checked. The accessible name is axe-core's
 * (`axe.commons.text.accessibleText`) when it is in the page.
 * @param {{ navNames?: boolean }} [options]
 */
export function landmarksInPage(options = {}) {
  const exposed = (element) => {
    if (element.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  const axe = globalThis.axe;
  const accessibleName = (element) =>
    axe?.commons?.text?.accessibleText
      ? axe.commons.text.accessibleText(element)
      : (element.getAttribute("aria-label") ?? element.textContent ?? "");
  const findings = [];
  const modalOpen = [
    ...document.querySelectorAll(
      '[aria-modal="true"], dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"]',
    ),
  ].some(exposed);
  const mains = [...document.querySelectorAll('main, [role="main"]')].filter(exposed);
  if (modalOpen) {
    // The page behind a modal is hidden on purpose: its landmarks are checked without it.
  } else if (mains.length === 0) {
    findings.push({ rule: "no-main", target: null, summary: "The page has no main landmark" });
  } else if (mains.length > 1) {
    findings.push({
      rule: "many-main",
      target: null,
      summary: `The page has ${mains.length} main landmarks`,
    });
  }
  const headings = [...document.querySelectorAll('h1, [role="heading"][aria-level="1"]')].filter(
    exposed,
  );
  if (!modalOpen && headings.length === 0) {
    findings.push({ rule: "no-h1", target: null, summary: "The page has no level-1 heading" });
  }
  if (options.navNames) {
    // axe-core's text functions need its tree of the page, which only lives during a run.
    axe?.setup?.(document);
    try {
      for (const link of document.querySelectorAll('nav a[href], [role="navigation"] a[href]')) {
        if (!exposed(link) || accessibleName(link).trim() !== "") continue;
        findings.push({
          rule: "unnamed-nav-link",
          target: `a[href="${link.getAttribute("href")}"]`,
          summary: "A navigation link with an empty accessible name",
        });
      }
    } finally {
      axe?.teardown?.();
    }
  }
  return findings;
}
