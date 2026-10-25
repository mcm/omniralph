"use client";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { buttonClassName } from "./button.js";

export interface ConfirmDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** Called with `false` when the dialog cancels or confirms. */
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  /** The confirm button's label, naming the action (e.g. "Delete repository"). */
  confirmLabel: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Draws the confirm button in the coral danger style. */
  destructive?: boolean;
  /** Text the user must type exactly before confirm enables (e.g. the repository name). */
  typedConfirmation?: string;
  /** Called once when the user confirms; the dialog then closes. */
  onConfirm: () => void;
  /** An optional element that opens the dialog. */
  trigger?: ReactElement;
}

/**
 * Asks before an action runs (`role="alertdialog"`). Focus moves into the dialog, Escape
 * and Cancel close it, and confirm stays disabled until `typedConfirmation` (if any) matches.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  typedConfirmation,
  onConfirm,
  trigger,
}: ConfirmDialogProps) {
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const confirmed = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    // Each opening starts fresh: nothing typed, not yet confirmed.
    setWasOpen(open);
    if (open) setTyped("");
  }

  const matches = typedConfirmation === undefined || typed === typedConfirmation;

  function confirm() {
    if (!matches || confirmed.current) return;
    confirmed.current = true;
    onConfirm();
    onOpenChange(false);
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger> : null}
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="or-dialog__overlay" />
        <AlertDialog.Content
          className="or-root or-dialog"
          onOpenAutoFocus={(event) => {
            confirmed.current = false;
            // With a typed confirmation, start in the field; otherwise Radix focuses Cancel.
            if (inputRef.current) {
              event.preventDefault();
              inputRef.current.focus();
            }
          }}
        >
          <AlertDialog.Title className="or-dialog__title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="or-dialog__description">
            {description}
          </AlertDialog.Description>
          <form
            className="or-dialog__form"
            onSubmit={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            {typedConfirmation !== undefined ? (
              <div className="or-dialog__typed">
                <label htmlFor={inputId} className="or-dialog__typed-label">
                  Type <span className="or-mono">{typedConfirmation}</span> to confirm
                </label>
                <input
                  ref={inputRef}
                  id={inputId}
                  className="or-dialog__input"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
            ) : null}
            <div className="or-dialog__actions">
              <AlertDialog.Cancel className={buttonClassName("outline")}>
                {cancelLabel}
              </AlertDialog.Cancel>
              <button
                type="submit"
                className={buttonClassName(destructive ? "danger" : "solid")}
                disabled={!matches}
              >
                {confirmLabel}
              </button>
            </div>
          </form>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
