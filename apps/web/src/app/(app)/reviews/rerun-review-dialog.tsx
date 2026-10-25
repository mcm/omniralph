"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Label,
  Muted,
  RadioGroup,
  RadioGroupItem,
  Stack,
} from "@iamthemcmaster/ui";
import { toast } from "@omniralph/ui";
import { IconRefresh } from "@tabler/icons-react";
import { RERUN_MODES, type RerunMode, type RerunReviewInput } from "@omniralph/shared";
import { useCurrentUser } from "@/components/current-user";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import { rerunResultSchema } from "@/lib/api/reviews";

const MODE_LABELS: Record<RerunMode, { label: string; hint: string }> = {
  incremental: {
    label: "Incremental",
    hint: "Reviews the whole diff, but only reports issues that aren't already open.",
  },
  fresh: {
    label: "Fresh",
    hint: "Reviews from scratch. Open findings it raises again are superseded and their threads resolved.",
  },
};

/**
 * Re-run (admins only; hidden for members): a dialog to pick Incremental or
 * Fresh, then a review of the PR's current head is enqueued at the repository's depth and
 * its page opens (or the page of the review of that head already queued or running).
 */
export function RerunReviewDialog({
  reviewId,
  changeLabel,
  compact = false,
}: {
  reviewId: string;
  /** e.g. `#42` or `!7`. */
  changeLabel: string;
  /** An icon-only trigger (review list rows). */
  compact?: boolean;
}) {
  const isAdmin = useCurrentUser().role === "admin";
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<RerunMode>("incremental");
  const rerun = useApiMutation({
    mutationFn: (input: RerunReviewInput, { organizationId }) =>
      api.post(`/api/ui/reviews/${reviewId}/rerun`, rerunResultSchema, {
        body: input,
        organizationId,
      }),
    // The re-run review's page links to the new one; the lists and jobs gain it.
    invalidate: (keys) => [keys.reviews.all, keys.jobs.all],
    success: null,
    onSuccess: (result) => {
      if (result.active)
        toast(result.message ?? "A review is already running.", { variant: "info" });
      else toast(`Re-run of ${changeLabel} queued`);
      onOpenChange(false);
      router.push(`/reviews/${result.reviewId}`);
    },
  });
  // Once queued, it stays pending while the new review's page opens.
  const pending = rerun.isPending || rerun.isSuccess;
  if (!isAdmin) return null;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setMode("incremental");
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    rerun.mutate({ mode, depth: null });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {compact ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Re-run review of ${changeLabel}`}
            title="Re-run"
          >
            <IconRefresh size={14} />
          </Button>
        ) : (
          <Button variant="secondary">
            <IconRefresh size={14} />
            Re-run
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Re-run review of {changeLabel}</DialogTitle>
            <DialogDescription>
              Reviews the current head of the {changeLabel.startsWith("!") ? "merge" : "pull"}{" "}
              request and posts the results there.
            </DialogDescription>
          </DialogHeader>
          <Stack asChild gap={4}>
            <DialogBody>
              <RadioGroup
                value={mode}
                onValueChange={(value) => setMode(value as RerunMode)}
                aria-label="Mode"
                className="gap-3"
              >
                {RERUN_MODES.map((value) => (
                  <div key={value} className="review-radio-option">
                    <RadioGroupItem id={`rerun-${reviewId}-${value}`} value={value} />
                    <Stack gap={1}>
                      <Label htmlFor={`rerun-${reviewId}-${value}`}>
                        {MODE_LABELS[value].label}
                      </Label>
                      <Muted className="text-xs">{MODE_LABELS[value].hint}</Muted>
                    </Stack>
                  </div>
                ))}
              </RadioGroup>
            </DialogBody>
          </Stack>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              <IconRefresh size={14} />
              {pending ? "Queuing…" : "Re-run"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
