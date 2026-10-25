"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

export interface TooltipProps {
  /** The tooltip text. It becomes the trigger's accessible description while shown. */
  content: ReactNode;
  /** The trigger: one element that accepts a ref and event handlers (e.g. a button). */
  children: ReactElement;
  /** Which side of the trigger the tooltip sits on. Defaults to `top`. */
  side?: "top" | "right" | "bottom" | "left";
  /** Suppresses the tooltip (e.g. when a visible label already says the same thing). */
  disabled?: boolean;
  /** Extra class on the tooltip bubble (e.g. to show it only at some widths). */
  className?: string;
}

/** Delay before a tooltip opens on hover; keyboard focus opens it at once. */
export const TOOLTIP_DELAY_MS = 300;

/**
 * A short label shown on hover and keyboard focus. Each tooltip carries its own Radix
 * provider, so it works without any app-level setup.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  disabled = false,
  className,
}: TooltipProps) {
  if (disabled) return children;
  return (
    <TooltipPrimitive.Provider delayDuration={TOOLTIP_DELAY_MS} skipDelayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className={className ? `or-root or-tip ${className}` : "or-root or-tip"}
            side={side}
            sideOffset={6}
            collisionPadding={8}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
