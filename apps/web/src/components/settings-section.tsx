"use client";

import * as React from "react";
import { Button, Card, cn, focusFirstInvalid, Muted } from "@iamthemcmaster/ui";
import { IconArrowBackUp, IconCheck, IconDeviceFloppy } from "@tabler/icons-react";
import type { ActionResult } from "@/lib/action-result";
import type { SettingChange } from "@/lib/settings/changes";
import {
  ConfirmChangesDialog,
  type SettingsConfirmation,
  type SettingsSave,
} from "./settings-card";
import { useUnsavedChanges } from "./unsaved-changes";
import { useAction } from "./use-action";

interface SettingsSectionProps {
  /** The section's anchor id. */
  id: string;
  title: string;
  /** False when the page's tab already names the section: the title is then for screen readers. */
  showTitle?: boolean;
  description: React.ReactNode;
  /** Beside the description, e.g. the control that turns the whole section on. */
  headerControl?: React.ReactNode;
  /** Danger sections hold settings that delete or rewrite work. */
  tone?: "default" | "danger";
  /** The section's unsaved changes; it is dirty when there are any. */
  changes: readonly SettingChange[];
  /** Validates the draft: the save to run, or null when the form shows errors instead. */
  prepare: () => SettingsSave | null;
  onDiscard: () => void;
  /** Confirm the change list before saving. */
  confirm?: SettingsConfirmation;
  /** Hides the save footer (people who can't change the settings). */
  readOnly?: boolean;
  /**
   * Replaces the footer's "Saved" after a save, e.g. while a harness hasn't picked the
   * change up yet ("Saved — waiting for …", then "Applied").
   */
  savedStatus?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * A section save made of several actions (e.g. a harness's config, then its pins): runs them in
 * order and stops at the first that fails, whose result it returns.
 */
export async function saveInOrder(
  saves: readonly (() => Promise<ActionResult>)[],
): Promise<ActionResult> {
  for (const save of saves) {
    const result = await save();
    if (!result.ok) return result;
  }
  return { ok: true };
}

/** The save footer's status: what a save would do, or why it can't yet. */
export function sectionStatus({
  changes,
  invalid,
  saved,
}: {
  changes: number;
  invalid: number;
  saved: boolean;
}): string {
  if (changes === 0) return saved ? "Saved" : "No unsaved changes";
  if (invalid > 0)
    return invalid === 1 ? "1 field needs attention" : `${invalid} fields need attention`;
  return changes === 1 ? "1 unsaved change" : `${changes} unsaved changes`;
}

/**
 * A section of related settings with one save: its description (the page's tab names it),
 * subsections separated by rules, and a footer that stays at the bottom of the viewport while
 * the section is on screen, so its save is always next to the settings it saves. A failed
 * validation counts the fields that need attention and focuses the first. While dirty, leaving
 * the page asks first (`useUnsavedChanges`); the footer itself says so, so the page's unsaved
 * bar doesn't list it.
 */
export function SettingsSection({
  id,
  title,
  showTitle = true,
  description,
  headerControl,
  tone = "default",
  changes,
  prepare,
  onDiscard,
  confirm,
  readOnly = false,
  savedStatus,
  children,
}: SettingsSectionProps) {
  const { pending, run } = useAction();
  const [confirming, setConfirming] = React.useState<SettingsSave | null>(null);
  const [invalid, setInvalid] = React.useState(0);
  // The changes a save just saved: "Saved" shows once they are gone, until the next edit.
  const [savedChanges, setSavedChanges] = React.useState<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const titleId = React.useId();
  const statusId = React.useId();
  const dirty = changes.length > 0;
  const changesKey = JSON.stringify(changes);
  if (savedChanges !== null && dirty && savedChanges !== changesKey) setSavedChanges(null);
  const saved = savedChanges !== null && !dirty;
  if (invalid > 0 && !dirty) setInvalid(0);
  useUnsavedChanges(title, id, dirty && !readOnly, { listed: false });

  const save = (request: SettingsSave) => {
    setSavedChanges(null);
    run(
      request.action,
      request.success,
      () => {
        setSavedChanges(changesKey);
        request.onSuccess?.();
      },
      request.onError,
    );
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || pending) return;
    const request = prepare();
    if (!request) {
      const root = formRef.current;
      // The errors render on the next commit; focusFirstInvalid waits a frame for them.
      void focusFirstInvalid(root).then(() =>
        setInvalid(Math.max(1, root?.querySelectorAll("[aria-invalid=true]").length ?? 0)),
      );
      return;
    }
    setInvalid(0);
    if (confirm) setConfirming(request);
    else save(request);
  };

  const state = !dirty ? (saved ? "saved" : "clean") : invalid > 0 ? "invalid" : "dirty";

  return (
    <Card id={id} className="settings-section" data-tone={tone} data-dirty={dirty ? "" : undefined}>
      <form ref={formRef} onSubmit={submit} noValidate aria-labelledby={titleId}>
        <header className="settings-section-header" data-compact={showTitle ? undefined : ""}>
          <h2 id={titleId} className={showTitle ? "settings-section-title" : "sr-only"}>
            {title}
          </h2>
          <div className="settings-section-heading">
            <Muted className="settings-section-description">{description}</Muted>
            {headerControl}
          </div>
        </header>
        <fieldset disabled={pending} className="settings-card-fieldset">
          <div className="settings-section-body">{children}</div>
        </fieldset>
        {!readOnly && (
          <footer className="settings-section-footer">
            <span
              id={statusId}
              className="settings-section-status"
              data-state={state}
              role="status"
            >
              {state === "saved" && savedStatus !== undefined ? (
                savedStatus
              ) : (
                <>
                  {state === "saved" && <IconCheck size={14} aria-hidden="true" />}
                  {sectionStatus({ changes: changes.length, invalid, saved })}
                </>
              )}
            </span>
            {dirty && (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setInvalid(0);
                  onDiscard();
                }}
              >
                <IconArrowBackUp size={14} />
                Discard
              </Button>
            )}
            <Button
              type="submit"
              variant={dirty ? "primary" : "secondary"}
              disabled={!dirty || pending}
              aria-describedby={statusId}
            >
              <IconDeviceFloppy size={14} />
              {pending ? "Saving…" : `Save ${title.toLowerCase()}`}
            </Button>
          </footer>
        )}
      </form>
      {confirm && (
        <ConfirmChangesDialog
          open={confirming !== null}
          onCancel={() => setConfirming(null)}
          title={`Save ${title.toLowerCase()}?`}
          consequence={confirm.consequence}
          affected={confirm.affected}
          changes={changes}
          onConfirm={() => {
            if (confirming) save(confirming);
          }}
        />
      )}
    </Card>
  );
}

/**
 * A section whose content acts at once instead of being saved, such as a list with add and
 * delete buttons, or the danger zone's revoke: the same card and header as `SettingsSection`,
 * without a form or save footer, so it can hold forms of its own.
 */
export function SettingsPanel({
  id,
  title,
  showTitle = true,
  description,
  tone = "default",
  children,
}: Pick<SettingsSectionProps, "id" | "title" | "showTitle" | "description" | "tone" | "children">) {
  const titleId = React.useId();
  return (
    <Card id={id} className="settings-section" data-tone={tone} interactive={false} asChild>
      <section aria-labelledby={titleId}>
        <header className="settings-section-header" data-compact={showTitle ? undefined : ""}>
          <h2 id={titleId} className={showTitle ? "settings-section-title" : "sr-only"}>
            {title}
          </h2>
          <Muted className="settings-section-description">{description}</Muted>
        </header>
        <div className="settings-section-body">{children}</div>
      </section>
    </Card>
  );
}

/**
 * One concern inside a section: a plain heading and its purpose above its fields. Subsections
 * are separated by a rule, never nested in cards.
 */
export function SettingsSubsection({
  id,
  title,
  description,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn("settings-sub", className)} aria-labelledby={`${id}-title`}>
      <div className="settings-sub-intro">
        <h3 id={`${id}-title`} className="settings-sub-title">
          {title}
        </h3>
        {description && <Muted className="settings-sub-description">{description}</Muted>}
      </div>
      <div className="settings-sub-fields">{children}</div>
    </section>
  );
}
