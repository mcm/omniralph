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
  Field,
  Label,
  Muted,
  NativeSelect,
  RadioGroup,
  RadioGroupItem,
} from "@iamthemcmaster/ui";
import { IconRefresh } from "@tabler/icons-react";
import { RERUN_MODES, RERUN_PROFILES, type RerunMode } from "@omniralph/shared";
import { toast } from "sonner";
import { useCurrentUser } from "@/components/current-user";
import { rerunReview } from "./actions";

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

const PROFILE_LABELS: Record<(typeof RERUN_PROFILES)[number], string> = {
  quick: "Quick",
  standard: "Standard",
  deep: "Deep",
};

/**
 * Re-run (admins only; hidden for members): a dialog to pick Incremental or
 * Fresh and a profile, then a review of the PR's current head is enqueued.
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
  const [profile, setProfile] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  if (!isAdmin) return null;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setMode("incremental");
      setProfile("");
    }
  };

  const view = (id: string) => ({
    label: "View review",
    onClick: () => router.push(`/reviews/${id}`),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const profileId = (RERUN_PROFILES as readonly string[]).includes(profile)
      ? (profile as (typeof RERUN_PROFILES)[number])
      : null;
    startTransition(async () => {
      const result = await rerunReview(reviewId, { mode, profileId });
      if (result.ok) {
        toast.success(`Re-run of ${changeLabel} queued`, { action: view(result.reviewId) });
        onOpenChange(false);
        router.refresh();
      } else if (result.activeReviewId) {
        toast.info(result.error, { action: view(result.activeReviewId) });
        onOpenChange(false);
      } else {
        toast.error(result.error);
      }
    });
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
          <DialogBody style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            <RadioGroup
              value={mode}
              onValueChange={(value) => setMode(value as RerunMode)}
              aria-label="Mode"
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
            >
              {RERUN_MODES.map((value) => (
                <div
                  key={value}
                  style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}
                >
                  <RadioGroupItem id={`rerun-${reviewId}-${value}`} value={value} />
                  <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                    <Label htmlFor={`rerun-${reviewId}-${value}`}>{MODE_LABELS[value].label}</Label>
                    <Muted style={{ fontSize: "var(--text-xs)" }}>{MODE_LABELS[value].hint}</Muted>
                  </div>
                </div>
              ))}
            </RadioGroup>
            <Field label="Profile" htmlFor={`rerun-${reviewId}-profile`}>
              <NativeSelect
                id={`rerun-${reviewId}-profile`}
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
              >
                <option value="">Repository default</option>
                {RERUN_PROFILES.map((id) => (
                  <option key={id} value={id}>
                    {PROFILE_LABELS[id]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </DialogBody>
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
