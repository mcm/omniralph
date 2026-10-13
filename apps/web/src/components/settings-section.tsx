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
  Button,
  Card,
  cn,
  focusFirstInvalid,
  Muted,
} from "@iamthemcmaster/ui";
import { IconArrowBackUp, IconDeviceFloppy } from "@tabler/icons-react";
import type { SettingChange } from "@/lib/settings/changes";
import {
  SettingChangeList,
  type SettingsConfirmation,
  type SettingsSave,
} from "./settings-card";
import { useAction } from "./use-action";

interface SettingsSectionProps {
  /** The anchor the section rail links to. */
  id: string;
  title: string;
  /** False when the page's tab already names the section: the title is then for screen readers. */
  showTitle?: boolean;
  description: React.ReactNode;
  /** In the header, after the title, e.g. the switch that turns the whole section on. */
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
  children: React.ReactNode;
}

/**
 * A section of related settings with one save: a header that names it, subsections in rows, and
 * a footer that stays at the bottom of the viewport while the section is on screen, so its save
 * is always next to the settings it saves. A failed validation names the count and focuses the
 * first invalid field.
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
  children,
}: SettingsSectionProps) {
  const { pending, run } = useAction();
  const [confirming, setConfirming] = React.useState<SettingsSave | null>(null);
  const [invalid, setInvalid] = React.useState(0);
  const formRef = React.useRef<HTMLFormElement>(null);
  const titleId = React.useId();
  const statusId = React.useId();
  const dirty = changes.length > 0;

  const save = (request: SettingsSave) =>
    run(request.action, request.success, request.onSuccess, request.onError);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || pending) return;
    const request = prepare();
    if (!request) {
      // The errors render on the next commit; count and focus them after it.
      requestAnimationFrame(() => {
        const root = formRef.current;
        setInvalid(root?.querySelectorAll("[aria-invalid=true]").length ?? 0);
        void focusFirstInvalid(root);
      });
      return;
    }
    setInvalid(0);
    if (confirm) setConfirming(request);
    else save(request);
  };

  const status = !dirty
    ? "No unsaved changes"
    : invalid > 0
      ? `${invalid === 1 ? "1 field needs" : `${invalid} fields need`} attention`
      : `${changes.length === 1 ? "1 unsaved change" : `${changes.length} unsaved changes`}`;

  return (
    <Card
      id={id}
      className="settings-section"
      data-tone={tone}
      data-dirty={dirty ? "" : undefined}
    >
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
              data-state={invalid > 0 && dirty ? "invalid" : dirty ? "dirty" : "clean"}
              aria-live="polite"
            >
              {status}
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
        <AlertDialog
          open={confirming !== null}
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Save {title.toLowerCase()}?</AlertDialogTitle>
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

/**
 * One concern inside a section: its name and purpose on the left, its settings on the right
 * (stacked on narrow screens). Subsections are separated by a rule, never nested in cards.
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
