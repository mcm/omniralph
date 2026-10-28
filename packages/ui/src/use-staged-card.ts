import * as React from "react";
import { ConfirmDialog } from "./actions/index.js";
import type { PendingChange } from "./surfaces/index.js";

/** A pending change as the card's save bar lists it: what changes, and what saving does. */
export interface StagedChange extends PendingChange {
  id: string;
  label: string;
  from?: string;
  to?: string;
  effect?: string;
}

/**
 * What a failed save rejects with: its `message` shows in the save bar, and an optional
 * machine-readable `code` and `fieldErrors` (by field path) are kept for the card to show
 * where they belong. Any `Error` fits.
 */
export interface StagedSaveError {
  message: string;
  code?: string;
  fieldErrors?: Record<string, string>;
}

export interface UseStagedCardOptions<T extends object, R = unknown> {
  /** The card's name, for the confirm dialog's default title. */
  label: string;
  /** The saved values (from the live query); a field is a top-level key. */
  saved: T;
  /** The save bar's items for the draft's differences from the saved values. */
  toChanges: (saved: T, draft: T) => StagedChange[];
  /**
   * Sends the whole draft. It resolves once the saved state shows (the answer written into
   * the cache), and rejects with a `StagedSaveError` when the save fails; toasts are its job.
   */
  save: (draft: T) => Promise<R>;
  /** The changes that need confirming before the save; none (or left out) saves at once. */
  needsConfirm?: (changes: StagedChange[]) => StagedChange[];
  /** The confirm dialog's title. Defaults to "Save <label> changes?". */
  confirmTitle?: string;
  /**
   * When set, a live update of the saved values while the card has changes (another admin's
   * save) is a conflict: `conflict` holds this message for the `SaveBar`, which then offers
   * Discard or `keepEditing` instead of Save. Without it, the draft stays on top silently.
   */
  conflictMessage?: string;
  /** Called with `dirty` each time it changes (and once on mount), e.g. to guard leaving. */
  onDirtyChange?: (dirty: boolean) => void;
}

export interface StagedCard<T> {
  /** The saved values with the user's edits on top. */
  draft: T;
  /** Edits one field; setting it back to its saved value un-stages it. */
  set: <K extends keyof T>(field: K, value: T[K]) => void;
  /** The pending changes, for the `SaveBar`. */
  changes: StagedChange[];
  /** Whether the draft has any pending change (`changes` isn't empty). */
  dirty: boolean;
  /** Drops every edit: the draft is the saved values again. */
  discard: () => void;
  /** Saves the draft (after the confirm dialog, when changes need confirming). */
  submit: () => void;
  saving: boolean;
  /** Why the last save failed (the save bar's `error`), until the next edit or save. */
  error: string | undefined;
  /** The machine-readable reason for the last failed save (to show it where it belongs). */
  errorCode: string | undefined;
  /** The last failed save's field errors, by field path (shown under their fields). */
  fieldErrors: Readonly<Record<string, string>>;
  /** The confirm dialog: render it with the card. */
  dialog: React.ReactElement | null;
  /**
   * The `SaveBar`'s `conflict` while someone else's save changed the saved values under the
   * draft (only with `conflictMessage`); undefined otherwise.
   */
  conflict: { message: string; onKeepEditing: () => void } | undefined;
}

/** Shown when a save fails with no message of its own. */
export const STAGED_SAVE_FAILED = "Something went wrong. Try again.";

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

const NO_FIELD_ERRORS: Readonly<Record<string, string>> = {};

function saveError(failure: unknown): Required<StagedSaveError> {
  const value = typeof failure === "object" && failure !== null ? failure : {};
  const message = "message" in value && typeof value.message === "string" ? value.message : "";
  const code = "code" in value && typeof value.code === "string" ? value.code : "";
  const fieldErrors =
    "fieldErrors" in value && typeof value.fieldErrors === "object" && value.fieldErrors !== null
      ? (value.fieldErrors as Record<string, string>)
      : NO_FIELD_ERRORS;
  return { message: message || STAGED_SAVE_FAILED, code, fieldErrors };
}

/**
 * A settings card's staged edits (the Repos save model, Design rule 11): the draft is the
 * saved values with the user's edits on top, so a live update of the saved values changes
 * the fields the user hasn't touched and keeps the edited ones. Every difference shows in
 * the card's `SaveBar` with its effect; Save sends the whole card in one `save` call (after
 * a `ConfirmDialog` listing the changes `needsConfirm` picks). The hook has no data layer of
 * its own: `save` writes the answer where the view reads it, and `onDirtyChange` lets the
 * app ask before leaving while the card is dirty.
 */
export function useStagedCard<T extends object, R = unknown>({
  label,
  saved,
  toChanges,
  save,
  needsConfirm,
  confirmTitle,
  conflictMessage,
  onDirtyChange,
}: UseStagedCardOptions<T, R>): StagedCard<T> {
  const [edits, setEdits] = React.useState<Partial<T>>({});
  // The saved values the draft was started from (or last kept on top of), to tell another
  // admin's save from the user's own edits.
  const [base, setBase] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | undefined>();
  const [errorCode, setErrorCode] = React.useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = React.useState(NO_FIELD_ERRORS);
  const [confirming, setConfirming] = React.useState<StagedChange[] | null>(null);
  const [saving, setSaving] = React.useState(false);
  // Guards a second submit before the `saving` render lands.
  const inFlight = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const draft = React.useMemo(() => ({ ...saved, ...edits }) as T, [saved, edits]);
  const edited = (Object.keys(edits) as (keyof T)[]).some(
    (field) => !same(edits[field], saved[field]),
  );
  const changes = React.useMemo(
    () => (edited ? toChanges(saved, draft) : []),
    [edited, toChanges, saved, draft],
  );
  // Dirty means something to save: an edit that `toChanges` sees as no change (a list put
  // back in another order, say) neither shows a save bar nor asks before leaving.
  const dirty = changes.length > 0;
  const conflicted = React.useMemo(
    () =>
      conflictMessage !== undefined &&
      dirty &&
      base !== null &&
      base !== saved &&
      toChanges(base, saved).length > 0,
    [conflictMessage, dirty, base, saved, toChanges],
  );

  // The latest callback, so callers can pass an inline one.
  const dirtyListener = React.useRef(onDirtyChange);
  React.useEffect(() => {
    dirtyListener.current = onDirtyChange;
  });
  React.useEffect(() => {
    dirtyListener.current?.(dirty);
  }, [dirty]);

  const clearErrors = () => {
    setError(undefined);
    setErrorCode(undefined);
    setFieldErrors(NO_FIELD_ERRORS);
  };

  const set = React.useCallback(
    <K extends keyof T>(field: K, value: T[K]) => {
      clearErrors();
      setBase((current) => current ?? saved);
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
    setBase(null);
    setEdits({});
  }, []);

  const keepEditing = React.useCallback(() => setBase(saved), [saved]);

  const run = (values: T) => {
    if (inFlight.current) return;
    inFlight.current = true;
    clearErrors();
    setSaving(true);
    save(values).then(
      () => {
        inFlight.current = false;
        if (!mounted.current) return;
        setSaving(false);
        setBase(null);
        // Edits made while the save was in flight stay staged.
        setEdits((current) => {
          const next: Partial<T> = {};
          for (const field of Object.keys(current) as (keyof T)[]) {
            if (!same(current[field], values[field])) next[field] = current[field];
          }
          return next;
        });
      },
      (failure: unknown) => {
        inFlight.current = false;
        if (!mounted.current) return;
        const { message, code, fieldErrors: errors } = saveError(failure);
        setSaving(false);
        setError(message);
        setErrorCode(code || undefined);
        setFieldErrors(errors);
      },
    );
  };

  const submit = () => {
    if (changes.length === 0 || saving || inFlight.current || conflicted) return;
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
    saving,
    error,
    errorCode,
    fieldErrors,
    dialog,
    conflict:
      conflicted && conflictMessage !== undefined
        ? { message: conflictMessage, onKeepEditing: keepEditing }
        : undefined,
  };
}
