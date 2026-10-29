"use client";

import { useState, type RefObject } from "react";

/**
 * The element focus should return to when an overlay opened from `focused` closes: `focused`
 * itself, or, for an item of a `Menu` (which unmounts as the overlay opens), the button that
 * opened that menu (Radix names a menu by its trigger, `aria-labelledby`).
 */
export function openerOf(focused: Element | null): HTMLElement | null {
  if (!(focused instanceof HTMLElement) || focused === document.body) return null;
  const menu = focused.closest('[role="menu"]');
  if (menu === null) return focused;
  const triggerId = menu.getAttribute("aria-labelledby");
  const trigger = triggerId ? document.getElementById(triggerId) : null;
  return trigger ?? null;
}

/**
 * The element that opened an overlay, read when `open` turns true (during that render,
 * before a menu that opened it unmounts and focus falls to the body). Focus it on close
 * (`onCloseAutoFocus`) so it returns to the control that opened the overlay (WCAG 2.4.3).
 */
export function useOpener(open: boolean): HTMLElement | null {
  const [wasOpen, setWasOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && typeof document !== "undefined") setOpener(openerOf(document.activeElement));
  }
  return opener;
}

/**
 * `onCloseAutoFocus` for an overlay: focus `opener` (when still in the page) instead of
 * Radix's target, else `fallback` (for an overlay opened without a control, e.g. from a link
 * into the page, or whose opener is gone).
 */
export function returnFocusTo(
  opener: HTMLElement | null,
  fallback?: RefObject<HTMLElement | null>,
) {
  return (event: Event) => {
    const target = opener?.isConnected ? opener : fallback?.current;
    if (!target?.isConnected) return;
    event.preventDefault();
    target.focus();
  };
}
