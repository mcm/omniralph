"use client";

import type { AnchorHTMLAttributes, ComponentType, ReactNode, Ref } from "react";

type AnchorLike = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  ref?: Ref<HTMLAnchorElement>;
};

/** What assistive tech hears after a link that opens in a new tab. */
export const NEW_TAB_HINT = "(opens in a new tab)";

/** Marks a link `externalLinkProps` has handled (and lets CSS find new-tab links). */
const NEW_TAB = "data-new-tab";

const ABSOLUTE_URL = /^(?:https?:)?\/\//i;

function currentOrigin(): string | undefined {
  return typeof window === "undefined" ? undefined : window.location.origin;
}

/**
 * Whether `href` leads out of the panel: an absolute http(s) (or protocol-relative) URL on
 * another origin. Paths, fragments, `mailto:` and URLs on the panel's own origin stay
 * internal. Without an origin (server render) every absolute URL counts as external.
 */
export function isExternalHref(href: string, origin: string | undefined = currentOrigin()) {
  const trimmed = href.trim();
  if (!ABSOLUTE_URL.test(trimmed)) return false;
  try {
    const url = new URL(trimmed, origin ?? "https://internal.invalid");
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return origin === undefined || url.origin !== origin;
  } catch {
    return false;
  }
}

function withRel(rel: string | undefined): string {
  const tokens = new Set((rel ?? "").split(/\s+/).filter(Boolean));
  tokens.add("noopener");
  tokens.add("noreferrer");
  return [...tokens].join(" ");
}

/**
 * Props for a link that opens external pages in a new tab: an external `href` without its
 * own `target` gets `target="_blank"`; any new-tab link gets `rel="noopener noreferrer"` and
 * says so to assistive tech (in its `aria-label`, or as visually hidden text). An explicit
 * `target` wins, so a caller can keep an external link in this tab with `target="_self"`.
 */
export function externalLinkProps<P extends AnchorLike>(props: P, origin?: string): P {
  // Already handled (e.g. apps/web's Link inside the UiProvider wrapper): don't hint twice.
  if (NEW_TAB in props) return props;
  const target =
    props.target ?? (isExternalHref(props.href, origin ?? currentOrigin()) ? "_blank" : undefined);
  if (target !== "_blank") return props;
  const label = props["aria-label"];
  const children: ReactNode =
    label === undefined ? (
      <>
        {props.children} <span className="or-sr-only">{NEW_TAB_HINT}</span>
      </>
    ) : (
      props.children
    );
  return {
    ...props,
    target,
    rel: withRel(props.rel),
    [NEW_TAB]: "",
    ...(label === undefined ? {} : { "aria-label": `${label} ${NEW_TAB_HINT}` }),
    children,
  };
}

const AWARE = new WeakMap<ComponentType<never>, ComponentType<never>>();
const WRAPPED = new WeakSet<ComponentType<never>>();

/**
 * Wraps a link component so external links open in a new tab (`externalLinkProps`). Stable:
 * the same component always gets the same wrapper, and a wrapper isn't wrapped again.
 */
export function withExternalLinks<P extends AnchorLike>(Link: ComponentType<P>): ComponentType<P> {
  const key = Link as ComponentType<never>;
  if (WRAPPED.has(key)) return Link;
  const cached = AWARE.get(key);
  if (cached) return cached as ComponentType<P>;
  function ExternalAwareLink(props: P) {
    return <Link {...externalLinkProps(props)} />;
  }
  ExternalAwareLink.displayName = `ExternalAware(${Link.displayName ?? Link.name ?? "Link"})`;
  AWARE.set(key, ExternalAwareLink as ComponentType<never>);
  WRAPPED.add(ExternalAwareLink as ComponentType<never>);
  return ExternalAwareLink;
}
