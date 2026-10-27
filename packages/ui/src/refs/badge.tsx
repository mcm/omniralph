"use client";

import type { HTMLAttributes, ReactNode, Ref } from "react";
import { useLinkComponent } from "../provider/index.js";

export interface BadgeLinkProps {
  /** Makes the badge a link, rendered through the `UiProvider` link component. */
  href?: string;
  className?: string;
}

interface RefBadgeProps
  extends BadgeLinkProps, Omit<HTMLAttributes<HTMLElement>, "title" | "className"> {
  /** Modifier for the badge kind, e.g. `repo` → `.or-ref--repo`. */
  kind: string;
  /** The leading icon or mark. */
  icon?: ReactNode;
  /** The full text. Long text is truncated with an ellipsis and kept in `title`. */
  text: string;
  mono?: boolean;
  strong?: boolean;
  /**
   * What assistive tech reads in place of `text` (and the icon), when the visible text is
   * only part of it (e.g. a file's name for its full path).
   */
  srText?: string;
  /** A tooltip for the whole badge (the text keeps its own `title`). */
  title?: string;
  /** Lets a `Tooltip` wrap the badge. */
  ref?: Ref<HTMLElement>;
}

/**
 * The shared shape of every reference badge: icon + one line of text in a bordered
 * pill. A plain `<span>` unless given `href`.
 */
export function RefBadge({
  kind,
  icon,
  text,
  mono = false,
  strong = false,
  srText,
  title,
  href,
  className,
  ref,
  ...dom
}: RefBadgeProps) {
  const LinkComponent = useLinkComponent();
  const classes = [
    "or-ref",
    `or-ref--${kind}`,
    strong && "or-ref--strong",
    href !== undefined && "or-ref--link",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const visible = (
    <>
      {icon}
      {/* Whitespace-only text is dropped in the flex row but separates the names. */}
      {icon ? " " : null}
      <span className={mono ? "or-ref__text or-mono" : "or-ref__text"} title={text}>
        {text}
      </span>
    </>
  );
  const content =
    srText === undefined ? (
      visible
    ) : (
      <>
        <span className="or-ref__visible" aria-hidden="true">
          {visible}
        </span>
        <span className="or-sr-only">{srText}</span>
      </>
    );
  if (href !== undefined) {
    return (
      <LinkComponent
        {...dom}
        ref={ref as Ref<HTMLAnchorElement>}
        href={href}
        className={classes}
        title={title}
      >
        {content}
      </LinkComponent>
    );
  }
  return (
    <span {...dom} ref={ref as Ref<HTMLSpanElement>} className={classes} title={title}>
      {content}
    </span>
  );
}
