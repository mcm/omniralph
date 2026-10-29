"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { IconX } from "@tabler/icons-react";
import { type ReactElement, type ReactNode, type RefObject } from "react";
import { returnFocusTo, useOpener } from "../actions/opener.js";

export interface SheetProps {
  /** Names the sheet and heads it. */
  title: string;
  /** One sentence under the title, read as the dialog's description. */
  description?: ReactNode;
  /** Whether the sheet is open (controlled). */
  open: boolean;
  /** Called with `false` on Escape, the "Close" button or a scrim click. */
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
  /** Pinned under the scrolling body, e.g. the flow's buttons. */
  footer?: ReactNode;
  /** An optional element that opens the sheet. */
  trigger?: ReactElement;
  /**
   * Where focus returns on close when no control in the page opened the sheet (it opened
   * from a link, say) or that control is gone: e.g. the page's own "Add" button.
   */
  returnFocus?: RefObject<HTMLElement | null>;
}

/**
 * A side flow beside the page (Radix dialog, modal): from the right at 480 px, full screen
 * at 768 px and narrower. Focus moves in and stays inside while it is open; Escape and the
 * "Close" button close it, and focus returns to the element that opened it.
 */
export function Sheet({
  title,
  description,
  open,
  onOpenChange,
  children,
  footer,
  trigger,
  returnFocus,
}: SheetProps) {
  // Without a `trigger`, Radix has nothing to refocus on close: remember who opened it (the
  // menu's trigger when a menu item opened it).
  const opener = useOpener(open);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="or-sheet__scrim" />
        <Dialog.Content
          className="or-root or-sheet"
          // Radix links the description itself; without one, say there is none.
          {...(description === undefined ? { "aria-describedby": undefined } : {})}
          onCloseAutoFocus={returnFocusTo(opener, returnFocus)}
        >
          <div className="or-sheet__head">
            <div className="or-sheet__heading">
              <Dialog.Title className="or-sheet__title">{title}</Dialog.Title>
              {description === undefined ? null : (
                <Dialog.Description className="or-sheet__description">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close
              className="or-icon-btn or-icon-btn--ghost or-icon-btn--md"
              aria-label="Close"
            >
              <IconX size={18} stroke={1.75} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="or-sheet__body">{children}</div>
          {footer === undefined ? null : <div className="or-sheet__footer">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
