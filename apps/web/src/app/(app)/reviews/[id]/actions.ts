"use server";

import { DismissFindingInput } from "@omniralph/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { runMemberAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";
import { dismissFindingWithFeedback, restoreDismissedFinding } from "@/lib/reviews/feedback";

const FindingId = z.uuid();

/**
 * Dismisses an open finding from the control panel: records `ui` feedback by
 * the signed-in user and resolves the finding's SCM thread. A thread that
 * can't be resolved comes back as a warning; the dismissal still stands.
 */
export async function dismissFinding(
  findingId: string,
  input: DismissFindingInput,
): Promise<ActionResult> {
  return runMemberAction(async (user) => {
    const parsed = DismissFindingInput.safeParse(input);
    if (!FindingId.safeParse(findingId).success || !parsed.success) {
      return {
        ok: false,
        error: parsed.error?.issues[0]?.message ?? "That finding doesn't exist.",
      };
    }
    const result = await dismissFindingWithFeedback(getDb(), {
      findingId,
      source: "ui",
      reason: parsed.data.reason,
      note: parsed.data.note ?? null,
      userId: user.id,
    });
    switch (result.status) {
      case "not_found":
        return { ok: false, error: "That finding doesn't exist." };
      case "conflict":
        return { ok: false, error: "Only open findings can be dismissed." };
    }
    revalidatePath(`/reviews/${result.finding.reviewId}`);
    return result.scmWarning ? { ok: true, warning: result.scmWarning } : { ok: true };
  });
}

/** Restores a dismissed finding to `open`; its feedback stays in the history, marked restored. */
export async function restoreFinding(findingId: string): Promise<ActionResult> {
  return runMemberAction(async (user) => {
    if (!FindingId.safeParse(findingId).success) {
      return { ok: false, error: "That finding doesn't exist." };
    }
    const result = await restoreDismissedFinding(getDb(), { findingId, userId: user.id });
    switch (result.status) {
      case "not_found":
        return { ok: false, error: "That finding doesn't exist." };
      case "conflict":
        return { ok: false, error: "Only dismissed findings can be restored." };
    }
    revalidatePath(`/reviews/${result.finding.reviewId}`);
  });
}
