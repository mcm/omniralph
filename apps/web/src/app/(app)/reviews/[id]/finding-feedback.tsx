"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Label,
  Muted,
  RadioGroup,
  RadioGroupItem,
  Textarea,
} from "@iamthemcmaster/ui";
import { IconArrowBackUp, IconBan } from "@tabler/icons-react";
import {
  DismissFindingInput,
  FEEDBACK_REASON_LABELS,
  FEEDBACK_REASONS,
  MAX_FEEDBACK_NOTE_LENGTH,
  type FeedbackReasonValue,
} from "@omniralph/shared";
import { useAction } from "@/components/use-action";
import { formatDateTime } from "@/lib/format-date";
import type { FeedbackView, FindingView } from "@/lib/reviews/display";
import { dismissFinding, restoreFinding } from "./actions";

const REASON_HINTS: Record<FeedbackReasonValue, string> = {
  false_positive: "The finding is wrong. The reviewer learns a rule from it.",
  wont_fix: "The finding is right, but it won't be changed.",
  not_relevant: "Correct in general, but it doesn't apply here.",
  other: "Explain in the note.",
};

const SOURCE_LABELS: Record<FeedbackView["source"], string> = {
  ui: "control panel",
  scm: "@bot dismiss",
};

/** "Dismiss": a dialog to pick a reason and add an optional note. */
export function DismissFindingDialog({ finding }: { finding: FindingView }) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState<FeedbackReasonValue>("false_positive");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | undefined>();
  const { pending, run } = useAction();

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setReason("false_positive");
      setNote("");
      setError(undefined);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = DismissFindingInput.safeParse({ reason, note });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setError(undefined);
    run(
      () => dismissFinding(finding.id, parsed.data),
      "Finding dismissed",
      () => onOpenChange(false),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <IconBan size={14} />
          Dismiss
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Dismiss finding</DialogTitle>
            <DialogDescription>
              &ldquo;{finding.title}&rdquo; is marked dismissed and its thread on the code host is
              resolved. You can restore it later.
            </DialogDescription>
          </DialogHeader>
          <DialogBody style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            <RadioGroup
              value={reason}
              onValueChange={(value) => setReason(value as FeedbackReasonValue)}
              aria-label="Reason"
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
            >
              {FEEDBACK_REASONS.map((value) => (
                <div
                  key={value}
                  style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}
                >
                  <RadioGroupItem id={`reason-${finding.id}-${value}`} value={value} />
                  <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                    <Label htmlFor={`reason-${finding.id}-${value}`}>
                      {FEEDBACK_REASON_LABELS[value]}
                    </Label>
                    <Muted style={{ fontSize: "var(--text-xs)" }}>{REASON_HINTS[value]}</Muted>
                  </div>
                </div>
              ))}
            </RadioGroup>
            <Field
              label="Note"
              htmlFor={`note-${finding.id}`}
              description={`Optional. ${note.length.toLocaleString()} / ${MAX_FEEDBACK_NOTE_LENGTH.toLocaleString()} characters.`}
              error={error}
            >
              <Textarea
                id={`note-${finding.id}`}
                rows={3}
                error={Boolean(error)}
                aria-invalid={Boolean(error)}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. The input is validated by the caller."
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              <IconBan size={14} />
              {pending ? "Dismissing…" : "Dismiss"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Restore": sets a dismissed finding back to open. */
export function RestoreFindingButton({ finding }: { finding: FindingView }) {
  const { pending, run } = useAction();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => run(() => restoreFinding(finding.id), "Finding restored")}
    >
      <IconArrowBackUp size={14} />
      {pending ? "Restoring…" : "Restore"}
    </Button>
  );
}

/** The finding's dismissals (control panel and `@bot dismiss`), oldest first. */
export function FeedbackHistory({ feedback }: { feedback: FeedbackView[] }) {
  if (feedback.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        paddingTop: "var(--space-3)",
        borderTop: "1px solid var(--border-subtle)",
      }}
    >
      <Muted style={{ fontSize: "var(--text-xs)" }}>Feedback</Muted>
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: "none",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        {feedback.map((entry) => (
          <li
            key={entry.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-1)",
              fontSize: "var(--text-sm)",
              color: "var(--text-secondary)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                flexWrap: "wrap",
              }}
            >
              <Badge variant="neutral" size="sm">
                {FEEDBACK_REASON_LABELS[entry.reason]}
              </Badge>
              <span>
                Dismissed by <span style={{ color: "var(--text-primary)" }}>{entry.actor}</span> via{" "}
                {SOURCE_LABELS[entry.source]} · {formatDateTime(entry.createdAt)}
              </span>
              {entry.restoredAt && (
                <Badge variant="neutral" size="sm">
                  restored
                </Badge>
              )}
            </div>
            {entry.note && (
              <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                &ldquo;{entry.note}&rdquo;
              </span>
            )}
            {entry.restoredAt && (
              <Muted style={{ fontSize: "var(--text-xs)" }}>
                Restored by {entry.restoredBy} · {formatDateTime(entry.restoredAt)}
              </Muted>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
