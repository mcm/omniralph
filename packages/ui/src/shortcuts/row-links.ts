import { isRendered } from "./definitions.js";

/** Marks a row's link: Next item and Previous item move focus between them. */
export const ROW_LINK_ATTRIBUTE = "data-or-row-link";

/** Marks a list of row links. Nested lists move as one (the outermost). */
export const ROW_LIST_ATTRIBUTE = "data-or-row-list";

/** Set on a `SplitView`'s list pane while both panes show: moving to a row opens it. */
export const OPEN_ON_MOVE_ATTRIBUTE = "data-or-open-on-move";

/** Spread on a screen's own row link, for a list that isn't a `ListRow` or `DataTable`. */
export const rowLinkProps = { [ROW_LINK_ATTRIBUTE]: "" } as const;

/** Spread on a screen's own list (or a wrapper of several), likewise. */
export const rowListProps = { [ROW_LIST_ATTRIBUTE]: "" } as const;

const LIST = `[${ROW_LIST_ATTRIBUTE}]`;
const LINK = `[${ROW_LINK_ATTRIBUTE}]`;

/** The outermost list containing `element`, if any. */
function outermostList(element: Element | null): Element | null {
  let list: Element | null = null;
  for (
    let node = element?.closest(LIST) ?? null;
    node;
    node = node.parentElement?.closest(LIST) ?? null
  ) {
    list = node;
  }
  return list;
}

/** The list's shown row links, in document order (a `DataTable` hides its table or cards). */
function shownLinks(list: Element): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(LINK)].filter(isRendered);
}

/** The row marked current (`aria-current`) in `links`: the one the detail shows. */
function currentIndex(links: readonly HTMLElement[], list: Element): number {
  return links.findIndex((link) => {
    const marked = link.closest("[aria-current]");
    return (
      marked !== null && list.contains(marked) && marked.getAttribute("aria-current") !== "false"
    );
  });
}

export interface RowMoveTarget {
  link: HTMLElement;
  /** The link's `href`, when moving to it should open it (a `SplitView` showing both panes). */
  openHref: string | null;
}

/**
 * Where Next item (`step` 1) or Previous item (-1) moves focus: in the list containing focus,
 * else the first list in `main` with shown rows. From a row link (or anything else in the
 * list), the next or previous row link, stopping at the ends; from outside the list, the row
 * after or before the current one, or the first row when none is current. Null without rows.
 */
export function rowMoveTarget(doc: Document, step: 1 | -1): RowMoveTarget | null {
  const active = doc.activeElement;
  let list = outermostList(active);
  let links = list ? shownLinks(list) : [];
  if (!list || links.length === 0) {
    const main = doc.querySelector("main") ?? doc.body;
    list = null;
    for (const candidate of main.querySelectorAll(LIST)) {
      if (outermostList(candidate) !== candidate) continue;
      links = shownLinks(candidate);
      if (links.length > 0) {
        list = candidate;
        break;
      }
    }
  }
  if (!list || links.length === 0) return null;

  let target: HTMLElement | undefined;
  const index = links.findIndex((link) => link === active);
  if (index !== -1) {
    target = links[Math.min(Math.max(index + step, 0), links.length - 1)];
  } else if (active && list.contains(active)) {
    // Focus on something else in a row (a checkbox, an action): the link after or before it.
    const following = links.findIndex(
      (link) => (active.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    );
    const after = following === -1 ? links.length : following;
    target = step === 1 ? (links[after] ?? links.at(-1)) : (links[after - 1] ?? links[0]);
  } else {
    const current = currentIndex(links, list);
    target =
      current === -1 ? links[0] : links[Math.min(Math.max(current + step, 0), links.length - 1)];
  }
  if (!target) return null;
  const openHref = target.closest(`[${OPEN_ON_MOVE_ATTRIBUTE}]`)
    ? target.getAttribute("href")
    : null;
  return { link: target, openHref };
}

/** The focused row link, which Open follows; null when focus isn't on one. */
export function focusedRowLink(doc: Document): HTMLElement | null {
  const active = doc.activeElement;
  return active instanceof HTMLElement && active.matches(LINK) ? active : null;
}
