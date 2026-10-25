"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  PREFERS_LIGHT_QUERY,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "./resolve.js";

export interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// Layout effect in the browser so the attribute changes before paint; plain effect on the server.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function prefersLightQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(PREFERS_LIGHT_QUERY);
}

function subscribePrefersLight(onChange: () => void): () => void {
  const query = prefersLightQuery();
  if (!query) return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const getPrefersLight = () => prefersLightQuery()?.matches ?? false;
const getServerPrefersLight = () => false;

/** Whether the OS currently prefers light, updating as it changes. */
function usePrefersLight(enabled: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => (enabled ? subscribePrefersLight(onChange) : () => {}),
    [enabled],
  );
  return useSyncExternalStore(subscribe, getPrefersLight, getServerPrefersLight);
}

export interface ThemeProviderProps {
  /** The saved preference. A new value replaces the current one. */
  preference: ThemePreference;
  /**
   * Called once each time `setPreference` changes the preference; the app persists it. The
   * new theme applies at once. If this returns a promise that rejects, the previous
   * preference comes back (unless another choice was made in the meantime).
   */
  onPreferenceChange?: (preference: ThemePreference) => void | Promise<unknown>;
  children?: ReactNode;
}

/**
 * Applies the theme as `data-theme` on `<html>`. With System it follows
 * `prefers-color-scheme` as the OS changes; persistence stays with the app.
 */
export function ThemeProvider({
  preference: savedPreference,
  onPreferenceChange,
  children,
}: ThemeProviderProps) {
  const [preference, setPreferenceState] = useState(savedPreference);
  const [lastSaved, setLastSaved] = useState(savedPreference);
  if (savedPreference !== lastSaved) {
    // The saved preference changed from outside (another device, a server refresh).
    setLastSaved(savedPreference);
    setPreferenceState(savedPreference);
  }

  const prefersLight = usePrefersLight(preference === "system");
  const resolved = resolveTheme(preference, prefersLight);

  useIsomorphicLayoutEffect(() => {
    // While hydrating, `prefersLight` is the server's guess (false); read the OS directly so
    // a light System preference never flashes dark.
    document.documentElement.dataset.theme =
      preference === "system" ? resolveTheme(preference, getPrefersLight()) : resolved;
  }, [preference, resolved]);

  // Counts choices, so a failed save only rolls back if it's still the latest one.
  const latestChange = useRef(0);
  const setPreference = useCallback(
    (next: ThemePreference) => {
      if (next === preference) return;
      const previous = preference;
      const change = ++latestChange.current;
      setPreferenceState(next);
      const saved = onPreferenceChange?.(next);
      if (saved && typeof saved.then === "function") {
        saved.then(undefined, () => {
          if (latestChange.current === change) setPreferenceState(previous);
        });
      }
    },
    [preference, onPreferenceChange],
  );

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The current preference, the theme it draws, and a setter. Requires a ThemeProvider. */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside a ThemeProvider.");
  return value;
}
