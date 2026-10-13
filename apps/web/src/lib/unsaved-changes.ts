/**
 * The unsaved-changes guard: leaving a page (an in-app link or a browser unload) while a form
 * on it has unsaved changes asks first. `components/unsaved-changes.tsx` wires it to React.
 */

/** "1 card has unsaved changes" / "3 cards have unsaved changes". */
export function unsavedSummary(count: number): string {
  return count === 1 ? "1 card has unsaved changes" : `${count} cards have unsaved changes`;
}

/** An id for a settings card's anchor, from its title: "Ralph › Tools" → "settings-ralph-tools". */
export function unsavedAnchorId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `settings-${slug || "card"}`;
}

/** The parts of a click the guard reads. */
export interface GuardClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/** The parts of a link the guard reads. */
export interface GuardAnchor {
  href: string;
  target: string;
  hasAttribute(name: string): boolean;
}

/**
 * Where a click on `anchor` navigates within the panel (path, query and hash), or null when the
 * guard should let it through: a new tab or window, a download, another origin (the browser's
 * unload prompt covers that), a link to a spot on the same page, or the page itself.
 */
export function guardedHref(
  click: GuardClick,
  anchor: GuardAnchor,
  current: string,
): string | null {
  if (click.defaultPrevented || click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;
  let url: URL;
  let here: URL;
  try {
    here = new URL(current);
    url = new URL(anchor.href, here);
  } catch {
    return null;
  }
  if (url.origin !== here.origin) return null;
  if (url.pathname === here.pathname && url.search === here.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

interface GuardWindow extends EventTarget {
  location: { href: string };
}

/**
 * Asks before leaving while `isDirty()`: a browser unload (reload, close, typing a URL, a link to
 * another site) gets the browser's own prompt, and an in-app link click on `root` is cancelled
 * and handed to `onLeave` with its destination, to confirm and navigate. Returns the uninstaller.
 */
export function installUnsavedGuard({
  win,
  root,
  isDirty,
  onLeave,
}: {
  win: GuardWindow;
  root: EventTarget;
  isDirty: () => boolean;
  onLeave: (href: string) => void;
}): () => void {
  const beforeUnload = (event: Event) => {
    if (!isDirty()) return;
    event.preventDefault();
    // Older browsers only prompt when returnValue is set.
    (event as unknown as { returnValue: string }).returnValue = "";
  };
  const click = (event: Event) => {
    if (!isDirty()) return;
    const target = event.target as { closest?: (selector: string) => GuardAnchor | null } | null;
    const anchor = typeof target?.closest === "function" ? target.closest("a[href]") : null;
    if (!anchor) return;
    const href = guardedHref(event as Event & GuardClick, anchor, win.location.href);
    if (!href) return;
    // Capture phase on the document: Next's Link handler (on the React root) never sees it.
    event.preventDefault();
    event.stopPropagation();
    onLeave(href);
  };
  win.addEventListener("beforeunload", beforeUnload);
  root.addEventListener("click", click, true);
  return () => {
    win.removeEventListener("beforeunload", beforeUnload);
    root.removeEventListener("click", click, true);
  };
}
