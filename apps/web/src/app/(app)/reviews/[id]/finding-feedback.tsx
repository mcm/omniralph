"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Cluster,
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
  Stack,
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
import { useMutationState } from "@tanstack/react-query";
import { Timestamp } from "@/components/list-table";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import { mutationResultSchema } from "@/lib/api/schemas";
import type { FeedbackView, FindingView } from "@/lib/reviews/display";

const REASON_HINTS: Record<FeedbackReasonValue, string> = {
  false_positive: "The finding is wrong. The reviewer learns a rule from it.",
  wont_fix: "The finding is right, but it won't be changed.",
  not_relevant: "Correct in general, but it doesn't apply here.",
  other: "Explain in the note.",
};

/** A dismissal or restore of a finding, as sent and as shown before the server answers. */
export type FindingChange =
  | { action: "dismiss"; findingId: string; input: DismissFindingInput }
  | { action: "restore"; findingId: string };

/** The status a change gives its finding. */
const STATUS_AFTER: Record<FindingChange["action"], FindingView["status"]> = {
  dismiss: "dismissed",
  restore: "open",
};

const feedbackMutationKey = (reviewId: string) => ["finding-feedback", reviewId];

/**
 * Dismisses and restores the review's findings: `change` sends one (members), and
 * `pendingStatus` holds the status each finding with a change in flight shows meanwhile, so
 * the finding moves at once (optimistic) and goes back by itself when the change fails (with
 * the server's error as a toast). The review's queries refetch before a change settles, so it
 * never flickers back on success.
 */
export function useFindingFeedback(reviewId: string) {
  const mutation = useApiMutation({
    mutationKey: feedbackMutationKey(reviewId),
    mutationFn: (change: FindingChange, { organizationId }) =>
      api.post(`/api/ui/findings/${change.findingId}/${change.action}`, mutationResultSchema, {
        body: change.action === "dismiss" ? change.input : undefined,
        organizationId,
      }),
    // Finding counts on the lists; a false positive's learned rule shows on the repository and
    // its job on Jobs.
    invalidate: (keys) => [keys.reviews.all, keys.repositories.all, keys.jobs.all],
    success: (_, change) =>
      change.action === "dismiss" ? "Finding dismissed" : "Finding restored",
  });
  const pending = useMutationState({
    filters: { mutationKey: feedbackMutationKey(reviewId), status: "pending" },
    select: (m) => m.state.variables as FindingChange | undefined,
  });
  const pendingStatus = new Map<string, FindingView["status"]>();
  for (const change of pending) {
    if (change) pendingStatus.set(change.findingId, STATUS_AFTER[change.action]);
  }
  return { change: mutation.mutate, pendingStatus };
}

const SOURCE_LABELS: Record<FeedbackView["source"], string> = {
  ui: "control panel",
  scm: "@bot dismiss",
};

/**
 * "Dismiss": a dialog to pick a reason and add an optional note. It closes on submit: the
 * finding shows dismissed while `onDismiss` (`useFindingFeedback`) sends it.
 */
export function DismissFindingDialog({
  finding,
  onDismiss,
}: {
  finding: FindingView;
  onDismiss: (input: DismissFindingInput) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState<FeedbackReasonValue>("false_positive");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | undefined>();

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
    onOpenChange(false);
    onDismiss(parsed.data);
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
          <Stack asChild gap={4}>
            <DialogBody>
              <RadioGroup
                value={reason}
                onValueChange={(value) => setReason(value as FeedbackReasonValue)}
                aria-label="Reason"
                className="gap-3"
              >
                {FEEDBACK_REASONS.map((value) => (
                  <div key={value} className="review-radio-option">
                    <RadioGroupItem id={`reason-${finding.id}-${value}`} value={value} />
                    <Stack gap={1}>
                      <Label htmlFor={`reason-${finding.id}-${value}`}>
                        {FEEDBACK_REASON_LABELS[value]}
                      </Label>
                      <Muted className="text-xs">{REASON_HINTS[value]}</Muted>
                    </Stack>
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
          </Stack>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              <IconBan size={14} />
              Dismiss
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Restore": sets a dismissed finding back to open (at once: see `useFindingFeedback`). */
export function RestoreFindingButton({ onRestore }: { onRestore: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onRestore}>
      <IconArrowBackUp size={14} />
      Restore
    </Button>
  );
}

/** The finding's dismissals (control panel and `@bot dismiss`), oldest first. */
export function FeedbackHistory({ feedback }: { feedback: FeedbackView[] }) {
  if (feedback.length === 0) return null;
  return (
    <div className="review-feedback">
      <Muted className="text-xs">Feedback</Muted>
      <Stack asChild gap={2} className="m-0 list-none p-0">
        <ul>
          {feedback.map((entry) => (
            <Stack asChild gap={1} key={entry.id} className="text-sm text-text-secondary">
              <li>
                <Cluster gap={2}>
                  <Badge variant="neutral" size="sm">
                    {FEEDBACK_REASON_LABELS[entry.reason]}
                  </Badge>
                  <span>
                    Dismissed by <span className="text-text-primary">{entry.actor}</span> via{" "}
                    {SOURCE_LABELS[entry.source]} · <Timestamp iso={entry.createdAt} inline />
                  </span>
                  {entry.restoredAt && (
                    <Badge variant="neutral" size="sm">
                      Restored
                    </Badge>
                  )}
                </Cluster>
                {entry.note && <span className="review-pre-wrap">&ldquo;{entry.note}&rdquo;</span>}
                {entry.restoredAt && (
                  <Muted className="text-xs">
                    Restored by {entry.restoredBy} · <Timestamp iso={entry.restoredAt} inline />
                  </Muted>
                )}
              </li>
            </Stack>
          ))}
        </ul>
      </Stack>
    </div>
  );
}
