"use client";

import { useLinkComponent } from "../provider/ui-provider.js";
import { Glyph } from "./glyph.js";

export interface WordmarkProps {
  className?: string;
}

/** The lowercase "omniralph" wordmark (17 px, weight 600). */
export function Wordmark({ className }: WordmarkProps) {
  return <span className={className ? `or-wordmark ${className}` : "or-wordmark"}>omniralph</span>;
}

export interface BrandLockupProps {
  /** Makes the lockup a home link (through the UiProvider link component). */
  href?: string;
  className?: string;
}

/** The 24 px glyph and the wordmark, baseline-aligned; a home link when given `href`. */
export function BrandLockup({ href, className }: BrandLockupProps) {
  const Link = useLinkComponent();
  const classes = className ? `or-lockup ${className}` : "or-lockup";
  const content = (
    <>
      <Glyph size={24} />
      <Wordmark />
    </>
  );
  if (href === undefined) return <span className={classes}>{content}</span>;
  return (
    <Link href={href} className={classes} aria-label="Omniralph home">
      {content}
    </Link>
  );
}
