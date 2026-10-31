"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Opens an element (a sheet, a dialog) over the run detail: the View PRD sheet, or what a run
 * ⋯ menu item that other screens add shows when chosen.
 */
export interface RunDetailOverlay {
  /** Shows `element` in the run detail, in place of any open one. */
  open: (element: ReactNode) => void;
  /** Takes the open element away (its dismiss calls this). */
  close: () => void;
}

const OverlayContext = createContext<RunDetailOverlay | null>(null);

/** The run detail's overlay, for a menu item's element and the element itself. */
export function useRunDetailOverlay(): RunDetailOverlay {
  const overlay = useContext(OverlayContext);
  if (!overlay) throw new Error("useRunDetailOverlay must be used inside a run detail.");
  return overlay;
}

/** Holds the run detail's open element and renders it after `children`. */
export function RunDetailOverlayProvider({ children }: { children: ReactNode }) {
  const [element, setElement] = useState<ReactNode>(null);
  const overlay = useMemo<RunDetailOverlay>(
    () => ({ open: (next) => setElement(next), close: () => setElement(null) }),
    [],
  );
  return (
    <OverlayContext.Provider value={overlay}>
      {children}
      {element}
    </OverlayContext.Provider>
  );
}
