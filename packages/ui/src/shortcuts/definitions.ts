/** Where an action is listed on the Help page. */
export type ShortcutGroup = "goTo" | "lists" | "inbox" | "runs" | "workItems" | "panels";

/**
 * One action's key. `key` is a single `event.key` value (never a list, so an action can't
 * have two keys); `mod` makes it a chord with Command (Meta) on Apple platforms and Ctrl elsewhere.
 */
export interface ShortcutDefinition {
  key: string;
  mod?: true;
  /** The action's name, as the Help page lists it. */
  label: string;
  group: ShortcutGroup;
  /** Fires while focus is in an editable field too (only Close, Escape). */
  allowInFields?: true;
  /** Fires on auto-repeat too (only Next item and Previous item). */
  repeat?: true;
}

/** The list actions the package's own components register. */
export type ListShortcutId = "listNext" | "listPrevious" | "listOpen" | "back";

/** `apple` reads Mod as Command (Meta), `other` as Ctrl. */
export type ShortcutPlatform = "apple" | "other";

/** The modifier and key state `matchesShortcut` reads from a key event. */
export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

const LETTER_OR_DIGIT = /^[a-z0-9]$/i;

/** Symbols typed with Shift on common layouts: their ARIA form names Shift. */
const SHIFTED_SYMBOLS = new Set([...'~!@#$%^&*()_+{}|:"<>?']);

/**
 * The key as the registry compares it: a single character lowercased (so Caps Lock and
 * `K` vs `k` don't matter), and the legacy "Esc" read as "Escape".
 */
export function normalizeKey(key: string): string {
  if (key === "Esc") return "Escape";
  return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * Whether `event` presses `definition`'s key. A Mod chord needs exactly the platform's
 * modifier (Command on Apple, Ctrl elsewhere) and no other. A plain key fires with no Ctrl, Command or
 * Alt held, and a letter or digit also without Shift, so Shift+letter and every browser
 * chord stay free; a symbol such as `?` is typed with Shift and allows it.
 */
export function matchesShortcut(
  event: ShortcutKeyEvent,
  definition: Pick<ShortcutDefinition, "key" | "mod">,
  platform: ShortcutPlatform,
): boolean {
  if (normalizeKey(event.key) !== normalizeKey(definition.key)) return false;
  if (event.altKey) return false;
  if (definition.mod) {
    const apple = platform === "apple";
    const mod = apple ? event.metaKey : event.ctrlKey;
    const other = apple ? event.ctrlKey : event.metaKey;
    return mod && !other && !event.shiftKey;
  }
  if (event.metaKey || event.ctrlKey) return false;
  return !(event.shiftKey && LETTER_OR_DIGIT.test(definition.key));
}

const NON_TEXT_INPUTS = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "range",
  "color",
]);

const TEXT_ROLES = '[role="textbox"], [role="searchbox"], [role="combobox"]';

/**
 * Whether typing in `element` would enter text: an `input` (other than a checkbox, radio,
 * button, submit, reset, range or color), a `textarea`, a `select`, anything inside
 * `[contenteditable]`, or a `textbox`, `searchbox` or `combobox`.
 */
export function isEditableTarget(element: Element | null | undefined): boolean {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "INPUT") {
    return !NON_TEXT_INPUTS.has((element as HTMLInputElement).type.toLowerCase());
  }
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (element.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  return element.closest(TEXT_ROLES) !== null;
}

/** Whether `element` takes up space on the page: not `hidden`, nor under `display: none`. */
export function isRendered(element: Element): boolean {
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === "function") return check.call(element);
  const view = element.ownerDocument.defaultView;
  for (let node: Element | null = element; node; node = node.parentElement) {
    if ((node as HTMLElement).hidden) return false;
    const style = view?.getComputedStyle(node);
    if (style?.display === "none" || style?.visibility === "hidden") return false;
  }
  return true;
}

const MODAL_SURFACES =
  '[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * Whether a modal surface is open: a dialog, alert dialog, menu or listbox (the phone
 * drawer, `ConfirmDialog`, `Sheet`, the search palette, a `Menu` or popover) is in the
 * document and shown. Its own keys apply then, and no shortcut fires.
 */
export function isModalOpen(doc: Document): boolean {
  for (const element of doc.querySelectorAll(MODAL_SURFACES)) {
    if (element.getAttribute("data-state") === "closed") continue;
    if (isRendered(element)) return true;
  }
  return false;
}

/** Whether this browser runs on an Apple platform (macOS, iOS, iPadOS), where Mod is Command. */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    ?.platform;
  return /mac|iphone|ipad|ipod/i.test(hinted || navigator.platform || "");
}

/** The Command sign, escaped: the package keeps the literal out of its sources (Design rule 7). */
const COMMAND_SIGN = "\u2318";

/**
 * The key as the Help page shows it: "Command-sign K" or "Ctrl+K" for a Mod chord by platform, "Esc"
 * for Escape, else the key itself ("j", "?", "1").
 */
export function formatShortcut(
  definition: Pick<ShortcutDefinition, "key" | "mod">,
  platform: ShortcutPlatform,
): string {
  const key = normalizeKey(definition.key);
  if (definition.mod) {
    const shown = key.length === 1 ? key.toUpperCase() : key;
    return platform === "apple" ? `${COMMAND_SIGN}${shown}` : `Ctrl+${shown}`;
  }
  return key === "Escape" ? "Esc" : key;
}

/**
 * The key in `aria-keyshortcuts` form: "Meta+K" or "Control+K" by platform, a letter
 * uppercased ("E"), a digit as is ("1"), a shifted symbol with Shift ("Shift+?").
 */
export function ariaKeyShortcuts(
  definition: Pick<ShortcutDefinition, "key" | "mod">,
  platform: ShortcutPlatform,
): string {
  const key = normalizeKey(definition.key);
  const parts: string[] = [];
  if (definition.mod) parts.push(platform === "apple" ? "Meta" : "Control");
  if (SHIFTED_SYMBOLS.has(key)) parts.push("Shift");
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join("+");
}
