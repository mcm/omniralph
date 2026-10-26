"use client";

import { useLinkComponent, type LinkProps } from "../provider/ui-provider.js";

/** An inline text link (e.g. a run's title in a sentence), routed through `UiProvider`. */
export function TextLink({ className, ...props }: LinkProps) {
  const Link = useLinkComponent();
  return <Link {...props} className={["or-link", className].filter(Boolean).join(" ")} />;
}
