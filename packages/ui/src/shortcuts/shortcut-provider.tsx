"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useNavigate } from "../provider/ui-provider.js";
import {
  ariaKeyShortcuts,
  isApplePlatform,
  isEditableTarget,
  isModalOpen,
  matchesShortcut,
  type ListShortcutId,
  type ShortcutDefinition,
  type ShortcutPlatform,
} from "./definitions.js";
import { focusedRowLink, rowMoveTarget } from "./row-links.js";

/**
 * Performs an action for its key. Returning `false` leaves the key unhandled (no
 * `preventDefault`), e.g. when the action has nothing to do at this width.
 */
export type ShortcutHandler = (event: KeyboardEvent) => void | boolean;

/** Every action's key, by id. It must hold the package's own list actions. */
export type ShortcutDefinitions = Readonly<Record<string, ShortcutDefinition>> &
  Readonly<Record<ListShortcutId, ShortcutDefinition>>;

interface Registration {
  handler: { current: ShortcutHandler };
  enabled: { current: boolean };
}

class ShortcutRegistry {
  private readonly byId = new Map<string, Registration[]>();

  register(id: string, registration: Registration): () => void {
    const list = this.byId.get(id) ?? [];
    list.push(registration);
    this.byId.set(id, list);
    return () => {
      const current = this.byId.get(id) ?? [];
      this.byId.set(
        id,
        current.filter((entry) => entry !== registration),
      );
    };
  }

  /** The enabled registrations for `id`, the most recently mounted last. */
  enabled(id: string): Registration[] {
    return (this.byId.get(id) ?? []).filter((entry) => entry.enabled.current);
  }
}

interface ShortcutContextValue {
  registry: ShortcutRegistry;
  definitions: ShortcutDefinitions;
  platform: ShortcutPlatform;
}

const ShortcutContext = createContext<ShortcutContextValue | null>(null);

const subscribeNever = () => () => {};
const detectPlatform = (): ShortcutPlatform => (isApplePlatform() ? "apple" : "other");
// The server can't know the platform: it renders Ctrl, and the browser corrects it after
// hydration (no mismatch).
const serverPlatform = (): ShortcutPlatform => "other";

export interface ShortcutProviderProps {
  /** Every action's key (the app's registry). */
  definitions: ShortcutDefinitions;
  /** Whether Mod is Command (`apple`) or Ctrl (`other`). Detected from the browser by default. */
  platform?: ShortcutPlatform;
  /**
   * Logs an error naming the action when a key has more than one enabled handler (the most
   * recently mounted runs). For development builds.
   */
  reportConflicts?: boolean;
  children?: ReactNode;
}

/**
 * The app's keyboard shortcuts: the one document-level `keydown` listener. A key runs the
 * enabled handler `useShortcut` registered for its action, unless the event was already
 * handled, is part of IME composition or is an auto-repeat (other than Next and Previous
 * item); unless focus is in an editable field (other than for Close); and never while a
 * dialog, sheet, menu, popover or listbox is open, whose own keys apply. It renders nothing
 * of its own, and handles Next item, Previous item and Open over the page's row links.
 */
export function ShortcutProvider({
  definitions,
  platform: platformProp,
  reportConflicts = false,
  children,
}: ShortcutProviderProps) {
  const [registry] = useState(() => new ShortcutRegistry());
  const detected = useSyncExternalStore(subscribeNever, detectPlatform, serverPlatform);
  const platform = platformProp ?? detected;

  const settings = useRef({ definitions, platform, reportConflicts });
  useLayoutEffect(() => {
    settings.current = { definitions, platform, reportConflicts };
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      const { definitions, platform, reportConflicts } = settings.current;
      const match = Object.entries(definitions).find(([, definition]) =>
        matchesShortcut(event, definition, platform),
      );
      if (!match) return;
      const [id, definition] = match;
      if (event.repeat && !definition.repeat) return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      if (!definition.allowInFields && isEditableTarget(target)) return;
      if (isModalOpen(document)) return;
      const handlers = registry.enabled(id);
      const registration = handlers.at(-1);
      if (!registration) return;
      if (reportConflicts && handlers.length > 1) {
        console.error(
          `Shortcut "${id}" has ${handlers.length} enabled handlers; the most recently mounted ran.`,
        );
      }
      if (registration.handler.current(event) !== false) event.preventDefault();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [registry]);

  const value = useMemo(
    () => ({ registry, definitions, platform }),
    [registry, definitions, platform],
  );
  return (
    <ShortcutContext.Provider value={value}>
      <ListShortcuts />
      {children}
    </ShortcutContext.Provider>
  );
}

/** Next item, Previous item and Open, over the row links of the list in focus or in `main`. */
function ListShortcuts() {
  const navigate = useNavigate();
  const move = (step: 1 | -1) => {
    const target = rowMoveTarget(document, step);
    if (!target) return false;
    if (target.link !== document.activeElement) {
      target.link.focus();
      // Optional: jsdom has no layout.
      target.link.scrollIntoView?.({ block: "nearest" });
      // Both panes show: the detail follows the selection, without filling the history.
      if (target.openHref) navigate(target.openHref, { replace: true });
    }
  };
  useShortcut("listNext", () => move(1));
  useShortcut("listPrevious", () => move(-1));
  useShortcut("listOpen", () => {
    const link = focusedRowLink(document);
    if (!link) return false;
    link.click();
  });
  return null;
}

export interface UseShortcutOptions {
  /** Pass the same `enabled` the control renders with: a disabled control's key does nothing. */
  enabled?: boolean;
}

/**
 * Runs `handler` for action `id`'s key while the calling control is mounted and `enabled`.
 * Call it from the control that performs the action, with the handler its click runs. Does
 * nothing for a null `id` (the control has no key where it's shown), nor outside a
 * `ShortcutProvider`.
 */
export function useShortcut(
  id: string | null,
  handler: ShortcutHandler,
  { enabled = true }: UseShortcutOptions = {},
): void {
  const registry = useContext(ShortcutContext)?.registry;
  const handlerRef = useRef(handler);
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    handlerRef.current = handler;
    enabledRef.current = enabled;
  });
  useEffect(() => {
    if (!registry || id === null) return;
    return registry.register(id, { handler: handlerRef, enabled: enabledRef });
  }, [registry, id]);
}

/**
 * Action `id`'s key in `aria-keyshortcuts` form for this platform ("E", "Meta+K"), for the
 * control that performs it; undefined for a null or unknown id, or outside a `ShortcutProvider`.
 */
export function useKeyShortcuts(id: string | null): string | undefined {
  const context = useContext(ShortcutContext);
  const definition = id === null ? undefined : context?.definitions[id];
  return context && definition ? ariaKeyShortcuts(definition, context.platform) : undefined;
}

/** The platform the nearest `ShortcutProvider` reads Mod for (`other` without one). */
export function useShortcutPlatform(): ShortcutPlatform {
  return useContext(ShortcutContext)?.platform ?? "other";
}
