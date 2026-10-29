"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@omniralph/ui";
import { installUnsavedGuard, unsavedSummary } from "@/lib/unsaved-changes";

/** A form with unsaved changes, by its name. */
interface UnsavedEntry {
  label: string;
}

interface UnsavedContextValue {
  entries: readonly UnsavedEntry[];
  set: (key: string, entry: UnsavedEntry | null) => void;
}

const UnsavedContext = React.createContext<UnsavedContextValue | null>(null);

/**
 * Tracks which forms on the page have unsaved changes, and asks before leaving the page (an
 * in-app link or a browser unload) while any has. Each form shows its own unsaved state
 * where it is (a staged card's save bar), so the guard only names them when it asks.
 */
export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [byKey, setByKey] = React.useState<ReadonlyMap<string, UnsavedEntry>>(new Map());
  const [leaving, setLeaving] = React.useState<string | null>(null);
  const dirty = React.useRef(false);

  React.useEffect(() => {
    dirty.current = byKey.size > 0;
  }, [byKey]);

  React.useEffect(
    () =>
      installUnsavedGuard({
        win: window,
        root: document,
        isDirty: () => dirty.current,
        onLeave: setLeaving,
      }),
    [],
  );

  const set = React.useCallback((key: string, entry: UnsavedEntry | null) => {
    setByKey((previous) => {
      if (!entry && !previous.has(key)) return previous;
      const next = new Map(previous);
      if (entry) next.set(key, entry);
      else next.delete(key);
      return next;
    });
  }, []);

  const value = React.useMemo(() => ({ entries: [...byKey.values()], set }), [byKey, set]);

  return (
    <UnsavedContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={leaving !== null}
        onOpenChange={(open) => {
          if (!open) setLeaving(null);
        }}
        title="Leave without saving?"
        description={`${unsavedSummary(value.entries.length)}: ${value.entries
          .map((entry) => entry.label)
          .join(", ")}. Leaving the page discards them.`}
        cancelLabel="Keep editing"
        confirmLabel="Discard and leave"
        destructive
        onConfirm={() => {
          if (leaving) router.push(leaving);
        }}
      />
    </UnsavedContext.Provider>
  );
}

/** Marks a form as having unsaved changes while `dirty` (no-op outside the provider). */
export function useUnsavedChanges(label: string, dirty: boolean) {
  const context = React.useContext(UnsavedContext);
  const set = context?.set;
  const key = React.useId();
  React.useEffect(() => {
    if (!set || !dirty) return;
    set(key, { label });
    return () => set(key, null);
  }, [set, key, label, dirty]);
}
