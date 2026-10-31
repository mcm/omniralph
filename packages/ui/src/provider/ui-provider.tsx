"use client";

import {
  createContext,
  useContext,
  useMemo,
  type AnchorHTMLAttributes,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";
import { withExternalLinks } from "./external-link.js";

/** Props every link component receives: an anchor's attributes with a required `href`. */
export type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  ref?: Ref<HTMLAnchorElement>;
};

/** The component @omniralph/ui renders links with (e.g. Next's Link in apps/web). */
export type LinkComponent = ComponentType<LinkProps>;

/** The default link: a plain anchor, for consumers without a router. */
export function PlainLink(props: LinkProps) {
  return <a {...props} />;
}

/** Opens `href` in this tab; `replace` replaces the current history entry instead of adding one. */
export type Navigate = (href: string, options?: { replace?: boolean }) => void;

/** The default navigation, for consumers without a router: a full page load. */
export const locationNavigate: Navigate = (href, options) => {
  if (options?.replace) window.location.replace(href);
  else window.location.assign(href);
};

interface UiContextValue {
  linkComponent: LinkComponent;
  navigate: Navigate;
}

const UiContext = createContext<UiContextValue>({
  linkComponent: withExternalLinks(PlainLink),
  navigate: locationNavigate,
});

export interface UiProviderProps {
  /**
   * Renders every link the components draw. Defaults to a plain `<a>`. Either way, links
   * out of the panel open in a new tab (`withExternalLinks`).
   */
  linkComponent?: LinkComponent;
  /**
   * Navigates without a link (e.g. a list moving its selection), with the router's
   * `push`/`replace` in apps/web. Defaults to `location.assign`/`replace`.
   */
  navigate?: Navigate;
  children?: ReactNode;
}

/** Supplies the app's routing primitives to @omniralph/ui, which imports no framework. */
export function UiProvider({
  linkComponent = PlainLink,
  navigate = locationNavigate,
  children,
}: UiProviderProps) {
  const value = useMemo(
    () => ({ linkComponent: withExternalLinks(linkComponent), navigate }),
    [linkComponent, navigate],
  );
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

/** The link component from the nearest UiProvider (a plain `<a>` without one). */
export function useLinkComponent(): LinkComponent {
  return useContext(UiContext).linkComponent;
}

/** The navigation from the nearest UiProvider (`location.assign`/`replace` without one). */
export function useNavigate(): Navigate {
  return useContext(UiContext).navigate;
}
