"use client";

import NextLink, { useLinkStatus } from "next/link";
import * as React from "react";

/**
 * `next/link` with navigation feedback: while the page it opens loads, the link shows as
 * pending (globals.css dims and pulses it after a short delay, so a fast navigation doesn't
 * flicker). Every link of the panel uses it: sidebar items, breadcrumbs, tabs, row links.
 */
export const Link = React.forwardRef<HTMLAnchorElement, React.ComponentProps<typeof NextLink>>(
  function Link({ children, ...props }, ref) {
    return (
      <NextLink ref={ref} {...props}>
        {children}
        <LinkStatus />
      </NextLink>
    );
  },
);

/** Marks its link as pending (`useLinkStatus` only works inside the link). */
function LinkStatus() {
  const { pending } = useLinkStatus();
  return <span className="link-status" data-pending={pending ? "" : undefined} aria-hidden />;
}

export default Link;
