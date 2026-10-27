"use client";

import { IconArrowRight } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Button } from "../actions/button.js";

export interface PendingChange {
  id: string;
  /** What changes, e.g. "Default branch". */
  label: ReactNode;
  /** The saved value. */
  from?: ReactNode;
  /** The value after saving. */
  to?: ReactNode;
  /** One sentence on what saving it will do. */
  effect?: ReactNode;
}

export interface SaveBarProps {
  /** The pending changes; the bar renders nothing when there are none. */
  changes: readonly PendingChange[];
  onSave: () => void;
  onDiscard: () => void;
  /** Disables the buttons while the save is in flight. */
  saving?: boolean;
  /** Why the last save failed, shown in an alert. */
  error?: ReactNode;
  /** The Save button's label, e.g. "Save 2 changes". Defaults to "Save". */
  saveLabel?: string;
  /**
   * Someone else saved what these changes edit: `message` shows in an alert, and the bar
   * offers Discard (take their version) or "Keep editing" (`onKeepEditing`: keep these
   * changes on top of theirs) instead of Save, so nothing is overwritten silently.
   */
  conflict?: { message: ReactNode; onKeepEditing: () => void };
  className?: string;
}

/**
 * Lists every pending change before it is saved (the Repos save model), with a neutral
 * Save (never `primary`, Design rule 6) and a quiet Discard.
 */
export function SaveBar({
  changes,
  onSave,
  onDiscard,
  saving = false,
  error,
  saveLabel = "Save",
  conflict,
  className,
}: SaveBarProps) {
  if (changes.length === 0) return null;
  const count = changes.length === 1 ? "1 unsaved change" : `${changes.length} unsaved changes`;
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className={["or-savebar", className].filter(Boolean).join(" ")}
    >
      <div className="or-savebar__body">
        <p className="or-savebar__count">{count}</p>
        <ul className="or-pending">
          {changes.map((change) => (
            <li key={change.id} className="or-pending__item">
              <span className="or-pending__label">{change.label}</span>
              {change.from !== undefined || change.to !== undefined ? (
                <span className="or-pending__values">
                  {change.from !== undefined ? (
                    <span className="or-pending__from">{change.from}</span>
                  ) : null}
                  {change.from !== undefined && change.to !== undefined ? (
                    <>
                      {" "}
                      <IconArrowRight
                        className="or-pending__arrow"
                        size={14}
                        stroke={1.75}
                        role="img"
                        aria-label="to"
                      />{" "}
                    </>
                  ) : null}
                  {change.to !== undefined ? (
                    <span className="or-pending__to">{change.to}</span>
                  ) : null}
                </span>
              ) : null}
              {change.effect !== undefined ? (
                <span className="or-pending__effect">{change.effect}</span>
              ) : null}
            </li>
          ))}
        </ul>
        {conflict ? (
          <p role="alert" className="or-savebar__conflict">
            {conflict.message}
          </p>
        ) : null}
        {error !== undefined && error !== null && error !== false ? (
          <p role="alert" className="or-savebar__error">
            {error}
          </p>
        ) : null}
      </div>
      <div className="or-savebar__actions">
        <Button variant="ghost" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        {conflict ? (
          <Button variant="solid" onClick={conflict.onKeepEditing} disabled={saving}>
            Keep editing
          </Button>
        ) : (
          <Button
            variant="solid"
            onClick={onSave}
            disabled={saving}
            aria-busy={saving || undefined}
          >
            {saving ? "Saving…" : saveLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
