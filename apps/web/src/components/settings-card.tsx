"use client";

import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cn,
  Field,
  Switch,
} from "@iamthemcmaster/ui";
import { IconArrowBackUp, IconDeviceFloppy } from "@tabler/icons-react";
import type { ActionResult } from "@/lib/action-result";
import type { SettingChange } from "@/lib/settings/changes";
import { useAction } from "./use-action";

/** A validated save: the server action and what to say when it succeeds. */
export interface SettingsSave {
  action: () => Promise<ActionResult>;
  success: string;
  onSuccess?: () => void;
  onError?: (result: Extract<ActionResult, { ok: false }>) => void;
}

/** Asks before saving a run-affecting card. */
export interface SettingsConfirmation {
  /** What the change affects and when, e.g. "Runs pick it up with their next job." */
  consequence: string;
  /** More of what changes, e.g. the repositories using a profile. */
  affected?: React.ReactNode;
}

interface SettingsCardProps {
  title: string;
  /** Next to the title, e.g. a "Built-in" badge. */
  titleExtra?: React.ReactNode;
  description: React.ReactNode;
  children: React.ReactNode;
  /** The card's unsaved changes; the card is dirty when there are any. */
  changes: readonly SettingChange[];
  /** Validates the draft: the save to run, or null when the form shows errors instead. */
  prepare: () => SettingsSave | null;
  onDiscard: () => void;
  /** Confirm the change list before saving. */
  confirm?: SettingsConfirmation;
  /** Hides the save actions (people who can't change the settings). */
  readOnly?: boolean;
  /** Disables the save action (e.g. a revoked harness). */
  disabled?: boolean;
  /** More footer buttons, before Discard and Save. */
  actions?: React.ReactNode;
  contentClassName?: string;
}

/** The "old → new" list of a card's unsaved changes. */
export function SettingChangeList({ changes }: { changes: readonly SettingChange[] }) {
  return (
    <dl className="settings-changes">
      {changes.map((change) => (
        <div key={change.key} className="settings-change">
          <dt className="settings-change-label">{change.label}</dt>
          <dd className="settings-change-values">
            <span className="settings-change-from">
              <span className="sr-only">From </span>
              {change.from}
            </span>
            <span aria-hidden="true" className="settings-change-arrow">
              →
            </span>
            <span className="settings-change-to">
              <span className="sr-only">to </span>
              {change.to}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A card of related settings with its own save. Save is enabled, and Discard shown, only while
 * the card has unsaved changes; a run-affecting card confirms the change list first. While it
 * saves, its controls are disabled (a disabled fieldset).
 */
export function SettingsCard({
  title,
  titleExtra,
  description,
  children,
  changes,
  prepare,
  onDiscard,
  confirm,
  readOnly = false,
  disabled = false,
  actions,
  contentClassName,
}: SettingsCardProps) {
  const { pending, run } = useAction();
  const [confirming, setConfirming] = React.useState<SettingsSave | null>(null);
  const dirty = changes.length > 0;
  const statusId = React.useId();

  const save = (request: SettingsSave) =>
    run(request.action, request.success, request.onSuccess, request.onError);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || pending) return;
    const request = prepare();
    if (!request) return;
    if (confirm) setConfirming(request);
    else save(request);
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate aria-label={title}>
        <CardHeader
          action={
            dirty && !readOnly ? (
              <Badge variant="warning" size="sm" id={statusId}>
                Unsaved changes
              </Badge>
            ) : undefined
          }
        >
          <CardTitle as="h2" className={titleExtra ? "settings-card-title" : undefined}>
            {title}
            {titleExtra}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <fieldset disabled={pending} className="settings-card-fieldset">
          <CardContent className={cn("settings-card-content", contentClassName)}>
            {children}
          </CardContent>
        </fieldset>
        {!readOnly && (
          <CardFooter>
            {actions}
            {dirty && (
              <Button type="button" variant="ghost" disabled={pending} onClick={onDiscard}>
                <IconArrowBackUp size={14} />
                Discard
              </Button>
            )}
            <Button
              type="submit"
              variant={dirty ? "primary" : "secondary"}
              disabled={!dirty || pending || disabled}
              aria-describedby={dirty ? statusId : undefined}
            >
              <IconDeviceFloppy size={14} />
              {pending ? "Saving…" : "Save"}
            </Button>
          </CardFooter>
        )}
      </form>
      {confirm && (
        <AlertDialog
          open={confirming !== null}
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Save {title}?</AlertDialogTitle>
              <AlertDialogDescription>{confirm.consequence}</AlertDialogDescription>
              <SettingChangeList changes={changes} />
              {confirm.affected}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (confirming) save(confirming);
                }}
              >
                Save {changes.length === 1 ? "1 change" : `${changes.length} changes`}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </Card>
  );
}

/** A switch setting: label, what it does and its default. */
export function SwitchField({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" label={label} htmlFor={id} description={description}>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </Field>
  );
}
