"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@iamthemcmaster/ui";
import { IconAlertTriangle } from "@tabler/icons-react";
import { installUnsavedGuard, unsavedSummary } from "@/lib/unsaved-changes";

/** A form with unsaved changes: its name and the id of the element to scroll to. */
interface UnsavedEntry {
  label: string;
  anchorId: string;
}

interface UnsavedContextValue {
  entries: readonly UnsavedEntry[];
  set: (key: string, entry: UnsavedEntry | null) => void;
}

const UnsavedContext = React.createContext<UnsavedContextValue | null>(null);

/**
 * Tracks which forms on the page have unsaved changes, and asks before leaving the page (an
 * in-app link or a browser unload) while any has. `UnsavedChangesBar` shows them.
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
      <AlertDialog
        open={leaving !== null}
        onOpenChange={(open) => {
          if (!open) setLeaving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              {unsavedSummary(value.entries.length)}:{" "}
              {value.entries.map((entry) => entry.label).join(", ")}. Leaving the page discards
              them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              onClick={() => {
                if (leaving) router.push(leaving);
              }}
            >
              Discard and leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UnsavedContext.Provider>
  );
}

/** Marks a form as having unsaved changes while `dirty` (no-op outside the provider). */
export function useUnsavedChanges(label: string, anchorId: string, dirty: boolean) {
  const context = React.useContext(UnsavedContext);
  const set = context?.set;
  const key = React.useId();
  React.useEffect(() => {
    if (!set || !dirty) return;
    set(key, { label, anchorId });
    return () => set(key, null);
  }, [set, key, label, anchorId, dirty]);
}

/** In page order: entries register in the order they became dirty. */
function inPageOrder(entries: readonly UnsavedEntry[]): UnsavedEntry[] {
  const position = (entry: UnsavedEntry) => document.getElementById(entry.anchorId);
  return [...entries].sort((a, b) => {
    const left = position(a);
    const right = position(b);
    if (!left || !right) return 0;
    return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}

/**
 * Sticks to the bottom of the page while any form has unsaved changes: how many, with a link
 * to each, since a dirty card is often scrolled out of view.
 */
export function UnsavedChangesBar() {
  const context = React.useContext(UnsavedContext);
  if (!context || context.entries.length === 0) return null;
  const entries = inPageOrder(context.entries);
  return (
    <div role="status" className="unsaved-bar">
      <IconAlertTriangle size={16} aria-hidden="true" className="unsaved-bar-icon" />
      <span className="unsaved-bar-summary">{unsavedSummary(entries.length)}:</span>
      <ul className="unsaved-bar-links">
        {entries.map((entry) => (
          <li key={entry.anchorId}>
            <a href={`#${entry.anchorId}`} className="inline-link">
              {entry.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
