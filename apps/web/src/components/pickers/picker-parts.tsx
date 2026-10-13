"use client";

import * as React from "react";
import { Badge } from "@iamthemcmaster/ui";
import { IconAlertTriangle, IconX } from "@tabler/icons-react";

/** What a stale value (saved, but no longer among the picker's options) is called. */
export const NOT_AVAILABLE = "not available";

/**
 * A selected value as a chip with an accessible remove button. A stale chip (a saved value that
 * is no longer among the options) is drawn as a warning and says so in text, not only by color.
 */
export function PickerChip({
  label,
  stale = false,
  disabled = false,
  onRemove,
}: {
  label: string;
  stale?: boolean;
  disabled?: boolean;
  onRemove: () => void;
}) {
  return (
    <Badge
      variant={stale ? "warning" : "neutral"}
      className="picker-chip"
      data-stale={stale || undefined}
    >
      {stale ? <IconAlertTriangle size={12} aria-hidden="true" /> : null}
      <span className="picker-chip-label" title={label}>
        {label}
      </span>
      {stale ? <span className="picker-chip-note">{NOT_AVAILABLE}</span> : null}
      {disabled ? null : (
        <button
          type="button"
          className="picker-chip-remove"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
        >
          <IconX size={12} aria-hidden="true" />
        </button>
      )}
    </Badge>
  );
}

/** A visible warning under a picker, for saved values that aren't among its options. */
export function StaleNote({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} className="picker-stale-note">
      <IconAlertTriangle size={14} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/**
 * A polite live region that announces selection changes ("Added Bug", "Removed Bug").
 * Returns the region to render and the function that sets its message.
 */
export function useAnnouncer(): [React.ReactNode, (message: string) => void] {
  const [message, setMessage] = React.useState("");
  const region = (
    <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </span>
  );
  return [region, setMessage];
}

/** Whether `label` (or `value`) contains `query`, ignoring case. An empty query matches all. */
export function matchesQuery(query: string, ...texts: (string | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return texts.some((text) => text?.toLowerCase().includes(needle));
}

/** Joins space-separated id lists, dropping empty ones. */
export function joinIds(...ids: (string | undefined | false)[]): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined || undefined;
}
