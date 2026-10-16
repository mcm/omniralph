"use client";

import * as React from "react";

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A form's draft seeded from query data (`saved`). When a refetch brings other saved
 * values, the draft follows them only while it isn't dirty (it equals the values it was
 * seeded from): a background refetch never overwrites what the user is editing. A save's
 * own refetch brings the draft's values, so the form is clean again. Values compare by
 * their JSON.
 */
export function useSeededDraft<T>(saved: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [draft, setDraft] = React.useState(saved);
  // The saved values the draft was last seeded from (or compared against).
  const [seed, setSeed] = React.useState(saved);
  if (!same(seed, saved)) {
    setSeed(saved);
    if (same(draft, seed)) setDraft(saved);
  }
  return [draft, setDraft];
}
