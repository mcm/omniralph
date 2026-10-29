"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { useLinkComponent } from "../provider/ui-provider.js";
import { OPEN_ON_MOVE_ATTRIBUTE } from "../shortcuts/row-links.js";
import { useShortcut } from "../shortcuts/shortcut-provider.js";

/** The container width (px) from which both panes show side by side. */
export const SPLIT_WIDE_MIN_WIDTH = 880;

/** The fixed pane's width: `wide` from a 1200 px viewport up, `narrow` below. */
export interface SplitWidth {
  wide: number;
  narrow: number;
}

export const DEFAULT_SPLIT_LIST_WIDTH: SplitWidth = { wide: 340, narrow: 300 };

export interface SplitViewProps {
  /** The list pane's content (a title, tabs or filters, and the rows). */
  list: ReactNode;
  /** The detail pane's content; null when nothing is selected. */
  detail: ReactNode | null;
  /** Which pane shows when there is room for one only. */
  view: "list" | "detail";
  /** The link back to the list, shown on the detail when only one pane shows ("‹ Inbox"). */
  backLink?: { label: string; href: string };
  /** Names the list pane, e.g. "Inbox". */
  listLabel: string;
  /**
   * The page's title, the `h1` the list pane shows (e.g. "Inbox"). While the detail shows
   * alone, the detail pane carries it as a visually hidden `h1`, so the page keeps its `h1`
   * and the detail's own title stays the `h2` under it.
   */
  title?: string;
  /** Names the detail pane; defaults to "Details". */
  detailLabel?: string;
  /** The fixed pane's width in px; defaults to 340 (wide) and 300 (narrow). */
  listWidth?: SplitWidth;
  /**
   * Which pane has the fixed width: `list` (default), or `detail`, which gives the width to
   * the detail pane and lets the list fill the rest (a table beside a side panel).
   */
  fixedPane?: "list" | "detail";
  className?: string;
  /** The size container (the root element), e.g. for `useSplitWide`. */
  ref?: Ref<HTMLDivElement>;
}

const DetailShownContext = createContext(true);

/**
 * Whether the detail pane of the `SplitView` around the caller shows (true outside one): a
 * control in a hidden detail pane registers no shortcut.
 */
export function useSplitDetailShown(): boolean {
  return useContext(DetailShownContext);
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * A list beside its selected item's detail. The panes sit in a size container: at a
 * container width of 880 px or more both show; below it only the pane named by `view`
 * does, the detail with its back link. One rule covers phone width and the narrower
 * content area beside a side panel.
 *
 * While the detail shows alone, the list (and the page's `h1` in it) is hidden: the detail
 * pane then carries `title` as a visually hidden `h1`.
 *
 * Keyboard: while both panes show, Next item and Previous item open the row they move to
 * (replacing the history entry), so the detail follows the selection. While the detail
 * shows alone, Back follows its back link.
 */
export function SplitView({
  list,
  detail,
  view,
  backLink,
  listLabel,
  title,
  detailLabel = "Details",
  listWidth = DEFAULT_SPLIT_LIST_WIDTH,
  fixedPane = "list",
  className,
  ref,
}: SplitViewProps) {
  const Link = useLinkComponent();
  const root = useRef<HTMLDivElement | null>(null);
  const setRoot = useCallback(
    (node: HTMLDivElement | null) => {
      root.current = node;
      assignRef(ref, node);
    },
    [ref],
  );
  const wide = useSplitWide(root);
  const backRef = useRef<HTMLAnchorElement>(null);
  const detailShown = wide || view === "detail";
  useShortcut("back", () => backRef.current?.click(), {
    enabled: backLink !== undefined && view === "detail" && !wide,
  });
  const style = {
    "--or-split-wide": `${listWidth.wide}px`,
    "--or-split-narrow": `${listWidth.narrow}px`,
  } as CSSProperties;
  return (
    <div
      ref={setRoot}
      className={["or-split", className].filter(Boolean).join(" ")}
      data-view={view}
      data-fixed={fixedPane}
      style={style}
    >
      <div className="or-split__panes">
        <section
          className="or-split__list"
          aria-label={listLabel}
          {...(wide ? { [OPEN_ON_MOVE_ATTRIBUTE]: "" } : {})}
        >
          {list}
        </section>
        <section className="or-split__detail" aria-label={detailLabel}>
          {backLink ? (
            <Link ref={backRef} href={backLink.href} className="or-split__back">
              <span aria-hidden="true">‹ </span>
              {backLink.label}
            </Link>
          ) : null}
          {title !== undefined && !wide && view === "detail" ? (
            <h1 className="or-split__title or-sr-only">{title}</h1>
          ) : null}
          <DetailShownContext.Provider value={detailShown}>{detail}</DetailShownContext.Provider>
        </section>
      </div>
    </div>
  );
}

/**
 * Whether the element in `ref` is at least 880 px wide (`SPLIT_WIDE_MIN_WIDTH`), so a
 * `SplitView` in it shows both panes. Follows the element's size (`ResizeObserver`);
 * false until measured.
 */
export function useSplitWide(ref: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (width: number) => setWide(width >= SPLIT_WIDE_MIN_WIDTH);
    measure(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return wide;
}
