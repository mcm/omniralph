"use client";

import { externalLinkProps } from "@omniralph/ui";
import NextLink, { useLinkStatus } from "next/link";
import * as React from "react";

/**
 * `next/link` with navigation feedback: while the page it opens loads, the link shows as
 * pending (globals.css dims and pulses it after a short delay, so a fast navigation doesn't
 * flicker). Every link of the panel uses it: sidebar items, breadcrumbs, tabs, row links.
 * A link out of the panel (Linear, GitHub, GitLab…) opens in a new tab (`externalLinkProps`).
 */
export const Link = React.forwardRef<HTMLAnchorElement, React.ComponentProps<typeof NextLink>>(
  function Link(props, ref) {
    if (typeof props.href === "string") {
      const external = externalLinkProps({ ...props, href: props.href });
      if (external.target === "_blank") {
        return <NextLink ref={ref} {...external} />;
      }
    }
    const { children, ...rest } = props;
    return (
      <NextLink ref={ref} {...rest}>
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
