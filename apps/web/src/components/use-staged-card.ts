"use client";

import { ConfirmDialog, type PendingChange } from "@omniralph/ui";
import * as React from "react";
import type { QueryKeys } from "@/lib/api/keys";
import { useUnsavedChanges } from "./unsaved-changes";
import { useApiMutation, type Invalidation, type MutationCache } from "./use-api-mutation";
import "./staged-card.css";

/** A pending change as the card's save bar lists it: what changes, and what saving does. */
export interface StagedChange extends PendingChange {
  id: string;
  label: string;
  from?: string;
  to?: string;
  effect?: string;
}

/** How a card saves: one request with the whole draft, its answer written into the cache. */
export interface StagedCardSave<T, R> {
  /** Sends the whole card (`useApiMutation`'s `mutationFn`). */
  request: (draft: T, meta: { organizationId: string }) => Promise<R>;
  /**
   * Writes the saved card from the answer into every cached query that shows it, so the view
   * shows the saved state without a refetch (`useApiMutation`'s `applyResult`).
   */
  applyResult: (result: R, cache: MutationCache, draft: T) => Promise<void> | void;
  /**
   * Queries to refetch in the background once saved. Defaults to none: the save's change
   * event reconciles every view showing the card, and the view never waits for it.
   */
  invalidate?: (keys: QueryKeys) => Invalidation[];
  /** The success toast. Defaults to "Saved". */
  success?: string;
}

export interface UseStagedCardOptions<T extends object, R> {
  /** The card's name, as "Leave without saving?" lists it. */
  label: string;
  /** The id of the card's element, which the unsaved-changes bar links to. */
  anchorId: string;
  /** The saved values (from the live query); a field is a top-level key. */
  saved: T;
  /** The save bar's items for the draft's differences from the saved values. */
  toChanges: (saved: T, draft: T) => StagedChange[];
  save: StagedCardSave<T, R>;
  /** The changes that need confirming before the save; none (or left out) saves at once. */
  needsConfirm?: (changes: StagedChange[]) => StagedChange[];
  /** The confirm dialog's title. Defaults to "Save <label> changes?". */
  confirmTitle?: string;
}

export interface StagedCard<T> {
  /** The saved values with the user's edits on top. */
  draft: T;
  /** Edits one field; setting it back to its saved value un-stages it. */
  set: <K extends keyof T>(field: K, value: T[K]) => void;
  /** The pending changes, for the `SaveBar`. */
  changes: StagedChange[];
  /** Whether any field differs from its saved value. */
  dirty: boolean;
  /** Drops every edit: the draft is the saved values again. */
  discard: () => void;
  /** Saves the draft (after the confirm dialog, when changes need confirming). */
  submit: () => void;
  saving: boolean;
  /** Why the last save failed (the save bar's `error`), until the next edit or save. */
  error: string | undefined;
  /** The last failed save's field errors, by field path (shown under their fields). */
  fieldErrors: Readonly<Record<string, string>>;
  /** The confirm dialog: render it with the card. */
  dialog: React.ReactElement | null;
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

const NO_FIELD_ERRORS: Readonly<Record<string, string>> = {};

/**
 * A settings card's staged edits (the Repos save model, Design rule 11): the draft is the
 * saved values with the user's edits on top, so a live update of the saved values changes
 * the fields the user hasn't touched and keeps the edited ones. Every difference shows in
 * the card's `SaveBar` with its effect; Save sends the whole card in one request (after a
 * `ConfirmDialog` listing the changes `needsConfirm` picks) and writes the answer into the
 * cache (`applyResult`), so the view shows the saved state at once. While dirty, the card is
 * registered with `UnsavedChangesProvider`, so leaving the page asks first.
 */
export function useStagedCard<T extends object, R>({
  label,
  anchorId,
  saved,
  toChanges,
  save,
  needsConfirm,
  confirmTitle,
}: UseStagedCardOptions<T, R>): StagedCard<T> {
  const [edits, setEdits] = React.useState<Partial<T>>({});
  const [error, setError] = React.useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = React.useState(NO_FIELD_ERRORS);
  const [confirming, setConfirming] = React.useState<StagedChange[] | null>(null);

  const draft = React.useMemo(() => ({ ...saved, ...edits }) as T, [saved, edits]);
  const dirty = (Object.keys(edits) as (keyof T)[]).some(
    (field) => !same(edits[field], saved[field]),
  );
  const changes = React.useMemo(
    () => (dirty ? toChanges(saved, draft) : []),
    [dirty, toChanges, saved, draft],
  );

  useUnsavedChanges(label, anchorId, dirty);

  const clearErrors = () => {
    setError(undefined);
    setFieldErrors(NO_FIELD_ERRORS);
  };

  const mutation = useApiMutation<R, T>({
    mutationFn: (values, meta) => save.request(values, meta),
    applyResult: (result, cache, values) => save.applyResult(result, cache, values),
    invalidate: (keys) => save.invalidate?.(keys) ?? [],
    success: save.success ?? "Saved",
    onSuccess: (_result, values) => {
      // Edits made while the save was in flight stay staged.
      setEdits((current) => {
        const next: Partial<T> = {};
        for (const field of Object.keys(current) as (keyof T)[]) {
          if (!same(current[field], values[field])) next[field] = current[field];
        }
        return next;
      });
    },
    onError: (failure) => {
      setError(failure.message);
      setFieldErrors(failure.fieldErrors ?? NO_FIELD_ERRORS);
    },
  });

  const set = React.useCallback(
    <K extends keyof T>(field: K, value: T[K]) => {
      clearErrors();
      setEdits((current) => {
        const next = { ...current };
        if (same(value, saved[field])) delete next[field];
        else next[field] = value;
        return next;
      });
    },
    [saved],
  );

  const discard = React.useCallback(() => {
    clearErrors();
    setEdits({});
  }, []);

  const run = (values: T) => {
    clearErrors();
    mutation.mutate(values);
  };

  const submit = () => {
    if (changes.length === 0 || mutation.isPending) return;
    const toConfirm = needsConfirm?.(changes) ?? [];
    if (toConfirm.length > 0) setConfirming(toConfirm);
    else run(draft);
  };

  const dialog = needsConfirm
    ? React.createElement(ConfirmDialog, {
        open: confirming !== null,
        onOpenChange: (open: boolean) => {
          if (!open) setConfirming(null);
        },
        title: confirmTitle ?? `Save ${label} changes?`,
        description: React.createElement(
          "span",
          { className: "or-staged-confirm" },
          ...(confirming ?? []).map((change) =>
            React.createElement(
              "span",
              { key: change.id, className: "or-staged-confirm__item" },
              React.createElement("strong", null, change.label),
              change.effect ? ` ${change.effect}` : null,
            ),
          ),
        ),
        confirmLabel: "Save changes",
        onConfirm: () => run(draft),
      })
    : null;

  return {
    draft,
    set,
    changes,
    dirty,
    discard,
    submit,
    saving: mutation.isPending,
    error,
    fieldErrors,
    dialog,
  };
}
