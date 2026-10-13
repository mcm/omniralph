/** Form pieces shared by the agent and task forms. */
import * as React from "react";
import Link from "next/link";
import { Badge, Button, Checkbox, Cluster, Label } from "@iamthemcmaster/ui";
import { IconArrowBackUp, IconDeviceFloppy } from "@tabler/icons-react";
import type { FieldErrors } from "@omniralph/shared";
import { useUnsavedChanges } from "@/components/unsaved-changes";

/** Names from a comma- or newline-separated list. */
export function splitNames(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** The error of `field` or of anything under it (`tools.builtin.2` for `tools.builtin`). */
export function errorFor(errors: FieldErrors, field: string): string | undefined {
  if (errors[field]) return errors[field];
  const nested = Object.keys(errors).find((key) => key.startsWith(`${field}.`));
  return nested && errors[nested];
}

function toggled<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on
    ? [...list.filter((item) => item !== value), value]
    : list.filter((item) => item !== value);
}

/** Checkboxes choosing some of `options`. */
export function Choices<T extends string>({
  id,
  options,
  value,
  onChange,
  disabled,
}: {
  id: string;
  options: readonly T[];
  value: readonly T[];
  onChange: (value: T[]) => void;
  disabled: boolean;
}) {
  return (
    <Cluster gap={4}>
      {options.map((option) => (
        <div key={option} className="settings-check settings-check-center">
          <Checkbox
            id={`${id}-${option}`}
            checked={value.includes(option)}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(toggled(value, option, checked === true))}
          />
          <Label htmlFor={`${id}-${option}`} className="settings-mono">
            {option}
          </Label>
        </div>
      ))}
    </Cluster>
  );
}

/**
 * An editor's save row: while an edit has unsaved changes, a badge and Discard; Save is disabled
 * while it has none. A dirty editor shows in the page's unsaved-changes bar and asks before the
 * page is left.
 */
export function EditorActions({
  anchorId,
  label,
  editing,
  dirty,
  pending,
  saveLabel,
  onDiscard,
  cancelHref,
}: {
  /** The row's id, which the unsaved-changes bar links to. */
  anchorId: string;
  /** What the unsaved-changes bar calls the editor, e.g. "Security review". */
  label: string;
  /** Editing a saved definition (a new one is always saveable). */
  editing: boolean;
  dirty: boolean;
  pending: boolean;
  /** E.g. "Save task" or "Create task". */
  saveLabel: string;
  onDiscard: () => void;
  /** Where Cancel goes. */
  cancelHref: string;
}) {
  const statusId = React.useId();
  useUnsavedChanges(label, anchorId, dirty);
  const showDirty = editing && dirty;
  return (
    <Cluster id={anchorId} align="center" className="definition-actions">
      <Button
        type="submit"
        variant={!editing || dirty ? "primary" : "secondary"}
        disabled={pending || (editing && !dirty)}
        aria-describedby={showDirty ? statusId : undefined}
      >
        <IconDeviceFloppy size={14} />
        {pending ? "Saving…" : saveLabel}
      </Button>
      {showDirty && (
        <Button type="button" variant="ghost" disabled={pending} onClick={onDiscard}>
          <IconArrowBackUp size={14} />
          Discard
        </Button>
      )}
      {/* A link, so leaving with unsaved changes asks first. */}
      <Button asChild variant="ghost">
        <Link href={cancelHref}>Cancel</Link>
      </Button>
      {showDirty && (
        <Badge variant="warning" size="sm" id={statusId}>
          Unsaved changes
        </Badge>
      )}
    </Cluster>
  );
}
