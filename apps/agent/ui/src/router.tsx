/**
 * The page's router: the browser history and the current path, nothing more. `Link` is
 * `UiProvider`'s link component, so every `@omniralph/ui` link navigates in place.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { LinkProps } from "@omniralph/ui";

interface RouterValue {
  path: string;
  navigate: (href: string) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children?: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigate = useCallback((href: string) => {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) {
      window.location.assign(url.href);
      return;
    }
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setPath(url.pathname);
  }, []);
  const value = useMemo(() => ({ path, navigate }), [path, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter must be used inside RouterProvider.");
  return value;
}

/** The current path (`location.pathname`). */
export function usePath(): string {
  return useRouter().path;
}

export function useNavigate(): (href: string) => void {
  return useRouter().navigate;
}

/** An anchor that navigates in place for a plain click on a same-origin link. */
export function Link({ href, onClick, target, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (target && target !== "_self") return;
    if (new URL(href, window.location.href).origin !== window.location.origin) return;
    event.preventDefault();
    navigate(href);
  };
  return <a {...rest} href={href} target={target} onClick={handleClick} />;
}
