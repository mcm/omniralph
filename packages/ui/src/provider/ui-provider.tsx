"use client";

import {
  createContext,
  useContext,
  type AnchorHTMLAttributes,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";

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

interface UiContextValue {
  linkComponent: LinkComponent;
}

const UiContext = createContext<UiContextValue>({ linkComponent: PlainLink });

export interface UiProviderProps {
  /** Renders every link the components draw. Defaults to a plain `<a>`. */
  linkComponent?: LinkComponent;
  children?: ReactNode;
}

/** Supplies the app's routing primitives to @omniralph/ui, which imports no framework. */
export function UiProvider({ linkComponent = PlainLink, children }: UiProviderProps) {
  return <UiContext.Provider value={{ linkComponent }}>{children}</UiContext.Provider>;
}

/** The link component from the nearest UiProvider (a plain `<a>` without one). */
export function useLinkComponent(): LinkComponent {
  return useContext(UiContext).linkComponent;
}
