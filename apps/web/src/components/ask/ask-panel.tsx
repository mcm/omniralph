"use client";

import type { NavItem } from "@omniralph/ui";
import * as React from "react";
import { AskChat } from "./ask-chat";
import { AskChatsList } from "./ask-chats-list";
import { AskNewChat } from "./ask-new-chat";
import "./ask-panel.css";

/** What the desktop Ask panel shows: the chats list, New chat, or a chat. */
export type AskPanelView = "list" | "new" | "chat";

export interface AskPanelState {
  open: boolean;
  view: AskPanelView;
  /** The chat shown when `view` is `chat`. */
  chatId: string | null;
}

/** Where the panel's state is mirrored, so a reload in the same tab reopens the same chat. */
export const ASK_PANEL_STORAGE_KEY = "omniralph-ask-panel";

/** The nav entry the panel belongs to (`src/lib/navigation.ts`). */
export const ASK_NAV_ID = "ask";

const CLOSED: AskPanelState = { open: false, view: "list", chatId: null };

/** The saved state, or null when there's none, it's malformed, or storage throws. */
export function readAskPanelState(): AskPanelState | null {
  try {
    const raw = window.sessionStorage.getItem(ASK_PANEL_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { open, view, chatId } = value as Record<string, unknown>;
    if (typeof open !== "boolean") return null;
    if (view !== "list" && view !== "new" && view !== "chat") return null;
    if (view === "chat") {
      return typeof chatId === "string" && chatId ? { open, view, chatId } : null;
    }
    return { open, view, chatId: null };
  } catch {
    return null;
  }
}

/** Saves the state; a storage that throws (private mode, quota, disabled) is ignored. */
export function writeAskPanelState(state: AskPanelState): void {
  try {
    window.sessionStorage.setItem(ASK_PANEL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The panel just won't come back after a reload.
  }
}

interface AskPanelSnapshot extends AskPanelState {
  /**
   * Whether the view should take focus when it mounts: after the member opened the panel or
   * moved within it, never when a reload restores it.
   */
  autoFocus: boolean;
}

interface AskPanelStore {
  snapshot: () => AskPanelSnapshot;
  subscribe: (listener: () => void) => () => void;
  set: (state: AskPanelState) => void;
}

const SERVER_SNAPSHOT: AskPanelSnapshot = { ...CLOSED, autoFocus: false };

function createAskPanelStore(): AskPanelStore {
  let current: AskPanelSnapshot | null = null;
  const listeners = new Set<() => void>();
  return {
    // Read from storage on first use, in the browser only (the server renders it closed).
    snapshot() {
      current ??= { ...(readAskPanelState() ?? CLOSED), autoFocus: false };
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(state) {
      current = { ...state, autoFocus: true };
      writeAskPanelState(state);
      for (const listener of listeners) listener();
    },
  };
}

export interface AskPanelControls extends AskPanelSnapshot {
  /** Opens the panel on its last view, or closes it (the Ask entry). */
  toggle: () => void;
  /** Closes the panel and returns focus to the Ask entry (Close Ask, Esc). */
  close: () => void;
  showList: () => void;
  showNew: () => void;
  showChat: (chatId: string) => void;
}

const AskPanelContext = React.createContext<AskPanelControls | null>(null);

/** The sidebar's Ask entry (the rail's too), where focus goes back when the panel closes. */
function focusAskEntry() {
  document.querySelector<HTMLElement>(`.or-sidebar [data-nav-id="${ASK_NAV_ID}"]`)?.focus();
}

/** Whether the window is wide enough for the panel (it's hidden on phones). */
function panelShown(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 769px)").matches;
}

/**
 * Owns the desktop Ask panel: `{open, view, chatId}`. It sits in the app shell, whose layout
 * persists across client-side navigation, so the panel stays open on the same chat as the
 * member moves between pages; the state is mirrored to `sessionStorage`, so a reload in the
 * same tab reopens it. While it's open, Esc closes it from anywhere, unless a dialog, menu
 * or popover handled the key first (`defaultPrevented`).
 */
export function AskPanelProvider({ children }: { children: React.ReactNode }) {
  const [store] = React.useState(createAskPanelStore);
  const snapshot = React.useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    () => SERVER_SNAPSHOT,
  );

  const controls = React.useMemo<AskPanelControls>(() => {
    const state = () => store.snapshot();
    const close = () => {
      store.set({ ...state(), open: false });
      focusAskEntry();
    };
    return {
      ...snapshot,
      toggle: () => {
        const { open, view, chatId } = state();
        store.set({ open: !open, view, chatId });
      },
      close,
      showList: () => store.set({ open: true, view: "list", chatId: null }),
      showNew: () => store.set({ open: true, view: "new", chatId: null }),
      showChat: (chatId) => store.set({ open: true, view: "chat", chatId }),
    };
  }, [store, snapshot]);

  const { open, close } = controls;
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (!panelShown()) return;
      event.preventDefault();
      close();
    };
    // Bubble phase on the document: Radix layers (dialogs, menus, popovers) handle Escape in
    // the capture phase and mark it handled, so they close first and the panel stays.
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  return <AskPanelContext.Provider value={controls}>{children}</AskPanelContext.Provider>;
}

/** The Ask panel's state and actions (inside `AskPanelProvider`). */
export function useAskPanel(): AskPanelControls {
  const controls = React.useContext(AskPanelContext);
  if (!controls) throw new Error("useAskPanel must be used inside AskPanelProvider.");
  return controls;
}

/**
 * The nav with the Ask entry wired to the panel: above 768 px a click toggles it instead of
 * opening `/ask`, and the entry is `aria-expanded` while it's open.
 */
export function withAskEntry(
  nav: readonly NavItem[],
  panel: Pick<AskPanelControls, "open" | "toggle">,
): readonly NavItem[] {
  return nav.map((item) =>
    item.id === ASK_NAV_ID
      ? { ...item, onSelect: () => panel.toggle(), expanded: panel.open }
      : item,
  );
}

/**
 * The desktop Ask panel (the frame's `aside`): an `aside` landmark named "Ask" showing the
 * chats list, New chat or a chat. "‹ Chats" goes to the list, "New chat" to New chat, and
 * "Close Ask" closes it. Opening it, or moving within it, focuses the view's composer or the
 * list's first chat.
 */
export function AskPanel() {
  const panel = useAskPanel();
  const { view, chatId, autoFocus, showList, showNew, showChat, close } = panel;
  let content: React.ReactNode;
  if (view === "chat" && chatId) {
    content = (
      <AskChat
        chatId={chatId}
        onBack={showList}
        onNewChat={showNew}
        onClose={close}
        autoFocus={autoFocus}
      />
    );
  } else if (view === "new") {
    content = (
      <AskNewChat
        onBack={showList}
        onChatStarted={(chat) => showChat(chat.id)}
        onClose={close}
        autoFocus={autoFocus}
      />
    );
  } else {
    content = (
      <AskChatsList
        onNewChat={showNew}
        onOpenChat={showChat}
        onClose={close}
        autoFocus={autoFocus}
      />
    );
  }
  return (
    <aside className="or-ask-panel" aria-label="Ask">
      {content}
    </aside>
  );
}
