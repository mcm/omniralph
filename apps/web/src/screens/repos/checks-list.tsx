"use client";

import { CodingCommand, MAX_CHECKS } from "@omniralph/tasks";
import { Button, IconButton, TextInput } from "@omniralph/ui";
import { IconArrowDown, IconArrowUp, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useId, useState, type KeyboardEvent } from "react";

/** The row being edited: an existing check's index, or `checks.length` for a new one. */
interface EditingCheck {
  index: number;
  value: string;
  error?: string;
}

/** Why `value` can't be a check (the API's own rule), or the command as it saves. */
export function parseCheck(value: string): { command: string } | { error: string } {
  const parsed = CodingCommand.safeParse(value);
  if (parsed.success) return { command: parsed.data };
  return { error: parsed.error.issues[0]?.message ?? "Enter a command." };
}

/** Moves the check at `from` to `to`. */
export function moveCheck(checks: readonly string[], from: number, to: number): string[] {
  const next = [...checks];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * The Coding card's Checks: the commands that must pass after every story and request on the
 * repo, as a numbered list of code rows. Admins add, edit, remove and reorder them; each
 * change stages in the card's save bar (`onChange`). `errorOf` reads a saved check's error
 * from the save's field errors.
 */
export function ChecksList({
  checks,
  onChange,
  canEdit,
  disabled,
  errorOf,
  error,
}: {
  checks: readonly string[];
  onChange: (checks: string[]) => void;
  canEdit: boolean;
  disabled: boolean;
  errorOf: (index: number) => string | undefined;
  error: string | undefined;
}) {
  const ids = useId();
  const [editing, setEditing] = useState<EditingCheck | null>(null);
  // A save, discard or live update can shorten the list under an edit: keep a new row last.
  const editingIndex = editing && Math.min(editing.index, checks.length);
  const full = checks.length >= MAX_CHECKS;

  const done = () => {
    if (!editing || editingIndex === null) return;
    const result = parseCheck(editing.value);
    if ("error" in result) {
      setEditing({ ...editing, error: result.error });
      return;
    }
    const next = [...checks];
    next.splice(editingIndex, editingIndex < checks.length ? 1 : 0, result.command);
    onChange(next);
    setEditing(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      done();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditing(null);
    }
  };

  const editor = (index: number) => (
    <li key={`edit-${index}`} className="or-repo-check-list__row">
      <div className="or-repo-check-list__editor">
        <TextInput
          aria-label={`Check ${index + 1}`}
          mono
          autoFocus
          value={editing?.value ?? ""}
          placeholder="pnpm test"
          disabled={disabled}
          onChange={(event) => setEditing({ index, value: event.target.value })}
          onKeyDown={onKeyDown}
          errorMessage={editing?.error}
        />
        <div className="or-repo-check-list__actions">
          <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" disabled={disabled} onClick={done}>
            Done
          </Button>
        </div>
      </div>
    </li>
  );

  return (
    <div className="or-repo-check-list">
      <h3 id={`${ids}-title`} className="or-repo-match__title">
        Checks
      </h3>
      <p className="or-repo-match__help">
        {checks.length === 0 && editing === null
          ? "No checks yet. Checks run after every story and request on this repo."
          : "Checks run in order after every story and request on this repo. Each must pass."}
      </p>
      {checks.length > 0 || editing !== null ? (
        <ol className="or-repo-check-list__rows" aria-labelledby={`${ids}-title`}>
          {checks.map((check, index) =>
            editingIndex === index ? (
              editor(index)
            ) : (
              <li key={`${index}-${check}`} className="or-repo-check-list__row">
                <div className="or-repo-check-list__command">
                  <code className="or-mono">{check}</code>
                  {errorOf(index) ? <p className="or-field-error">{errorOf(index)}</p> : null}
                </div>
                {canEdit && editing === null ? (
                  <div className="or-repo-check-list__actions">
                    <IconButton
                      label={`Edit check ${index + 1}`}
                      icon={IconPencil}
                      size="sm"
                      disabled={disabled}
                      onClick={() => setEditing({ index, value: check })}
                    />
                    <IconButton
                      label={`Move check ${index + 1} up`}
                      icon={IconArrowUp}
                      size="sm"
                      disabled={disabled || index === 0}
                      onClick={() => onChange(moveCheck(checks, index, index - 1))}
                    />
                    <IconButton
                      label={`Move check ${index + 1} down`}
                      icon={IconArrowDown}
                      size="sm"
                      disabled={disabled || index === checks.length - 1}
                      onClick={() => onChange(moveCheck(checks, index, index + 1))}
                    />
                    <IconButton
                      label={`Remove check ${index + 1}`}
                      icon={IconTrash}
                      size="sm"
                      disabled={disabled}
                      onClick={() => onChange(checks.filter((_, other) => other !== index))}
                    />
                  </div>
                ) : null}
              </li>
            ),
          )}
          {editingIndex === checks.length ? editor(checks.length) : null}
        </ol>
      ) : null}
      {canEdit && editing === null ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            icon={IconPlus}
            disabled={disabled || full}
            onClick={() => setEditing({ index: checks.length, value: "" })}
          >
            Add check
          </Button>
          {full ? (
            <p className="or-repo-match__note">{`A repo can have at most ${MAX_CHECKS} checks.`}</p>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="or-field-error">{error}</p> : null}
    </div>
  );
}
