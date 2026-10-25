"use client";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import { IconId, IconInfoCircle } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { ButtonIcon } from "../actions/button.js";
import { IconButton } from "../actions/icon-button.js";

interface PopoverButtonProps {
  label: string;
  icon: ButtonIcon;
  side?: "top" | "right" | "bottom" | "left";
  className: string;
  children: ReactNode;
}

/** An icon button that opens a Radix popover named by the button's label. */
function PopoverButton({ label, icon, side = "bottom", className, children }: PopoverButtonProps) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <IconButton label={label} icon={icon} size="sm" className="or-infobtn" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className={`or-root or-pop ${className}`}
          aria-label={label}
          side={side}
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export interface InfoPopoverProps {
  /** The ⓘ button's accessible name and tooltip. Defaults to "About this card". */
  label?: string;
  /** Which side of the button the popover opens on. Defaults to `bottom`. */
  side?: "top" | "right" | "bottom" | "left";
  /** The provenance shown in the popover (Design rule 11). */
  children: ReactNode;
}

/** An ⓘ button that opens a popover explaining where a card's facts come from. */
export function InfoPopover({ label = "About this card", side, children }: InfoPopoverProps) {
  return (
    <PopoverButton label={label} icon={IconInfoCircle} side={side} className="or-pop--info">
      {children}
    </PopoverButton>
  );
}

export interface DetailsItem {
  term: ReactNode;
  detail: ReactNode;
}

export interface DetailsPopoverProps {
  /** The ID-card button's accessible name and tooltip. Defaults to "Details". */
  label?: string;
  side?: "top" | "right" | "bottom" | "left";
  /** The facts, shown as a definition list. */
  items: readonly DetailsItem[];
}

/** An ID-card button that opens a popover listing an item's details (Design rule 17). */
export function DetailsPopover({ label = "Details", side, items }: DetailsPopoverProps) {
  return (
    <PopoverButton label={label} icon={IconId} side={side} className="or-pop--details">
      <dl className="or-pop__list">
        {items.map((item, index) => (
          <div className="or-pop__row" key={index}>
            <dt className="or-pop__term">{item.term}</dt>
            <dd className="or-pop__detail">{item.detail}</dd>
          </div>
        ))}
      </dl>
    </PopoverButton>
  );
}
