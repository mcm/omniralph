"use client";

import * as React from "react";

/**
 * The repo of the page the member is on (a repo page, or a run, review or work item's
 * repo), which New chat starts on. Pages register it with `useAskContextRepository`; the
 * latest registered page wins, and leaving the page unregisters it.
 */
interface AskContextStore {
  register: (repositoryId: string) => () => void;
  subscribe: (listener: () => void) => () => void;
  current: () => string | null;
}

function createAskContextStore(): AskContextStore {
  // One entry per registration, newest last.
  const entries: { repositoryId: string }[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    register(repositoryId) {
      const entry = { repositoryId };
      entries.push(entry);
      notify();
      return () => {
        const index = entries.indexOf(entry);
        if (index !== -1) entries.splice(index, 1);
        notify();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    current: () => entries.at(-1)?.repositoryId ?? null,
  };
}

const AskContext = React.createContext<AskContextStore | null>(null);

/** Holds the page's repo for Ask (in the app shell, around the pages and the Ask panel). */
export function AskContextProvider({ children }: { children: React.ReactNode }) {
  const [store] = React.useState(createAskContextStore);
  return <AskContext.Provider value={store}>{children}</AskContext.Provider>;
}

/**
 * Registers `repositoryId` (null: none) as the repo of the page while it's mounted, so New
 * chat starts on it. A no-op outside `AskContextProvider`.
 */
export function useAskContextRepository(repositoryId: string | null | undefined): void {
  const store = React.useContext(AskContext);
  React.useEffect(() => {
    if (!store || !repositoryId) return;
    return store.register(repositoryId);
  }, [store, repositoryId]);
}

const noSubscription = () => () => {};

/** The repo the page the member is on registered, or null. */
export function useAskContextRepositoryId(): string | null {
  const store = React.useContext(AskContext);
  return React.useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    () => store?.current() ?? null,
    () => null,
  );
}
