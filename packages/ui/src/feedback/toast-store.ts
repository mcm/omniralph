/**
 * The toast queue: a module-level store, so `toast()` works from hooks, plain callbacks and
 * code that runs before any `Toaster` has mounted (the toast shows once one does).
 */

/**
 * What a toast reports. `success` is a done action (mint dot), `info` and `warning` are
 * neutral, `danger` is a failure (coral dot, announced as an alert). Never lavender: a toast
 * never means "needs you" (Design rule 15).
 */
export type ToastVariant = "success" | "info" | "warning" | "danger";

export interface ToastOptions {
  /** Defaults to `success`. */
  variant?: ToastVariant;
  /** Milliseconds before it dismisses itself. Defaults to 5 s, or 8 s for `danger`. */
  duration?: number;
}

export interface ToastRecord {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
}

/** How long a toast stays up when no `duration` is given. */
export const TOAST_DURATIONS: Readonly<Record<ToastVariant, number>> = {
  success: 5_000,
  info: 5_000,
  warning: 5_000,
  danger: 8_000,
};

/** At most this many toasts show at once; a new one pushes out the oldest. */
export const MAX_TOASTS = 3;

const EMPTY: readonly ToastRecord[] = [];
let toasts: readonly ToastRecord[] = EMPTY;
let nextId = 1;
const listeners = new Set<() => void>();

function update(next: readonly ToastRecord[]) {
  toasts = next;
  for (const listener of listeners) listener();
}

/** Shows a toast; returns its id (for `dismissToast`). */
export function toast(message: string, options: ToastOptions = {}): number {
  const variant = options.variant ?? "success";
  const record: ToastRecord = {
    id: nextId++,
    message,
    variant,
    duration: options.duration ?? TOAST_DURATIONS[variant],
  };
  update([...toasts, record].slice(-MAX_TOASTS));
  return record.id;
}

/** Removes one toast. Unknown ids are ignored. */
export function dismissToast(id: number): void {
  if (toasts.some((record) => record.id === id)) {
    update(toasts.filter((record) => record.id !== id));
  }
}

/** Removes every toast (e.g. between tests). */
export function clearToasts(): void {
  if (toasts.length > 0) update(EMPTY);
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): readonly ToastRecord[] {
  return toasts;
}

export function getServerToasts(): readonly ToastRecord[] {
  return EMPTY;
}
