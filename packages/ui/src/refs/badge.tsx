"use client";

import type { ReactNode } from "react";
import { useLinkComponent } from "../provider/index.js";

export interface BadgeLinkProps {
  /** Makes the badge a link, rendered through the `UiProvider` link component. */
  href?: string;
  className?: string;
}

interface RefBadgeProps extends BadgeLinkProps {
  /** Modifier for the badge kind, e.g. `repo` → `.or-ref--repo`. */
  kind: string;
  /** The leading icon or mark. */
  icon?: ReactNode;
  /** The full text. Long text is truncated with an ellipsis and kept in `title`. */
  text: string;
  mono?: boolean;
  strong?: boolean;
  /** A tooltip for the whole badge (the text keeps its own `title`). */
  title?: string;
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
  title,
  href,
  className,
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
  const content = (
    <>
      {icon}
      {/* Whitespace-only text is dropped in the flex row but separates the names. */}
      {icon ? " " : null}
      <span className={mono ? "or-ref__text or-mono" : "or-ref__text"} title={text}>
        {text}
      </span>
    </>
  );
  if (href !== undefined) {
    return (
      <LinkComponent href={href} className={classes} title={title}>
        {content}
      </LinkComponent>
    );
  }
  return (
    <span className={classes} title={title}>
      {content}
    </span>
  );
}
