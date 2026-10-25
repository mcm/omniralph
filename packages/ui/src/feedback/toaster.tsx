"use client";

import { IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState, useSyncExternalStore, type FocusEvent } from "react";
import type { StatusTone } from "../status/index.js";
import {
  dismissToast,
  getServerToasts,
  getToasts,
  subscribeToasts,
  type ToastRecord,
  type ToastVariant,
} from "./toast-store.js";

/** The status dot's tone per variant: mint for success, coral for danger, else neutral. */
const TONES: Readonly<Record<ToastVariant, StatusTone>> = {
  success: "good",
  info: "neutral",
  warning: "neutral",
  danger: "fail",
};

export interface ToasterProps {
  /** The region's accessible name. Defaults to "Notifications". */
  label?: string;
  className?: string;
}

/**
 * Shows the toasts from `toast()`: bottom-right on desktop, above the tab bar on phone.
 * Mount one per page tree.
 */
export function Toaster({ label = "Notifications", className }: ToasterProps) {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getServerToasts);
  return (
    <section className={["or-toaster", className].filter(Boolean).join(" ")} aria-label={label}>
      {toasts.map((record) => (
        <ToastItem key={record.id} record={record} />
      ))}
    </section>
  );
}

/** One toast: it dismisses itself after its duration, paused while hovered or focused. */
function ToastItem({ record }: { record: ToastRecord }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(record.duration);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(() => dismissToast(record.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [paused, record.id]);

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
  };

  return (
    <div
      className={`or-toast or-toast--${record.variant}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    >
      <span className={`or-dot or-dot--${TONES[record.variant]}`} aria-hidden="true" />
      <div className="or-toast__message" role={record.variant === "danger" ? "alert" : "status"}>
        {record.message}
      </div>
      <button
        type="button"
        className="or-toast__dismiss"
        aria-label="Dismiss"
        onClick={() => dismissToast(record.id)}
      >
        <IconX size={14} stroke={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}
