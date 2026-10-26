"use client";

import { ConfirmDialog } from "@omniralph/ui";
import { useRouter } from "next/navigation";
import { useRemoveRepository } from "./mutations";

/** What removing a repo does: the Danger zone's line and the confirmation's description. */
export const REMOVE_REPO_DESCRIPTION =
  "Reviews, coding and Ask stop, its agent pins and work item match are removed, and its review history is kept.";

export interface RemoveRepoDialogProps {
  repository: { id: string; name: string; fullPath: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Asks before removing a repo (the ⋯ menu's "Remove repo…" and the Danger zone): the user
 * types its full path to confirm. Removing takes its row off the rail at once, toasts
 * "Removed <name>" and opens `/repos`.
 */
export function RemoveRepoDialog({ repository, open, onOpenChange }: RemoveRepoDialogProps) {
  const router = useRouter();
  const remove = useRemoveRepository(() => router.push("/repos"));
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Remove ${repository.fullPath}?`}
      description={REMOVE_REPO_DESCRIPTION}
      confirmLabel="Remove repo"
      destructive
      typedConfirmation={repository.fullPath}
      onConfirm={() => remove.mutate({ id: repository.id, name: repository.name })}
    />
  );
}
