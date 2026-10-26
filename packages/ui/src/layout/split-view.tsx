"use client";

import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { useLinkComponent } from "../provider/ui-provider.js";

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

/**
 * A list beside its selected item's detail. The panes sit in a size container: at a
 * container width of 880 px or more both show; below it only the pane named by `view`
 * does, the detail with its back link. One rule covers phone width and the narrower
 * content area beside a side panel.
 */
export function SplitView({
  list,
  detail,
  view,
  backLink,
  listLabel,
  detailLabel = "Details",
  listWidth = DEFAULT_SPLIT_LIST_WIDTH,
  fixedPane = "list",
  className,
  ref,
}: SplitViewProps) {
  const Link = useLinkComponent();
  const style = {
    "--or-split-wide": `${listWidth.wide}px`,
    "--or-split-narrow": `${listWidth.narrow}px`,
  } as CSSProperties;
  return (
    <div
      ref={ref}
      className={["or-split", className].filter(Boolean).join(" ")}
      data-view={view}
      data-fixed={fixedPane}
      style={style}
    >
      <div className="or-split__panes">
        <section className="or-split__list" aria-label={listLabel}>
          {list}
        </section>
        <section className="or-split__detail" aria-label={detailLabel}>
          {backLink ? (
            <Link href={backLink.href} className="or-split__back">
              <span aria-hidden="true">‹ </span>
              {backLink.label}
            </Link>
          ) : null}
          {detail}
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
