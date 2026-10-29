"use client";

import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";

export interface ScrollRegionProps extends Omit<HTMLAttributes<HTMLElement>, "role" | "tabIndex"> {
  /** Names the box while it scrolls, e.g. "Agents" or "Prompt". */
  label: string;
  /** The element to render: a `div` (default), or a `pre` for preformatted text. */
  as?: "div" | "pre";
  children?: ReactNode;
}

/** Whether `element`'s content is wider or taller than its box. */
function overflows(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight;
}

/**
 * A box whose content may scroll (a wide table, a long prompt). While its content overflows
 * it is a named, focusable group (`role="group"`, `tabIndex={0}`), so keyboard users can
 * scroll it with the arrow keys (WCAG 2.1.1); otherwise it is a plain element and no tab stop.
 * A group, not a region: a region is a landmark, and a table captioned like its card would
 * repeat the card's landmark name.
 */
export function ScrollRegion({
  label,
  as = "div",
  className,
  children,
  ...rest
}: ScrollRegionProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [scrolls, setScrolls] = useState(false);

  // Content changes don't resize the box, so measure after every render as well as on resize.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) setScrolls(overflows(element));
  });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setScrolls(overflows(element)));
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);

  const Element = as;
  return (
    <Element
      {...rest}
      ref={(node: HTMLElement | null) => {
        ref.current = node;
      }}
      className={[className, "or-scroll-region"].filter(Boolean).join(" ")}
      {...(scrolls ? { role: "group", "aria-label": label, tabIndex: 0 } : {})}
    >
      {children}
    </Element>
  );
}
