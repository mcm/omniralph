"use server";

import {
  acceptInvitation,
  createOrganization,
  declineInvitation,
  joinOrganization,
  setActiveOrganization,
  type AcceptInvitationResult,
} from "@omniralph/db";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runSignedInAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";

/** Longest organization name accepted. */
const MAX_NAME_LENGTH = 100;

const ACCEPT_ERRORS: Record<Exclude<AcceptInvitationResult, "accepted">, string> = {
  not_found: "That invitation no longer exists.",
  expired: "That invitation has expired. Ask an admin to invite you again.",
  revoked: "That invitation was revoked.",
  already_accepted: "That invitation was already accepted.",
  email_mismatch: "That invitation is for another email address.",
  email_not_allowed: "Your email domain is no longer allowed in that organization.",
};

/** Every page shows the active organization, so switching re-renders them all. */
function revalidateAll() {
  revalidatePath("/", "layout");
}

async function activate(userId: string, organizationId: string): Promise<ActionResult | void> {
  if (!(await setActiveOrganization(getDb(), { userId, organizationId }))) {
    return { ok: false, error: "You are not a member of that organization." };
  }
  revalidateAll();
}

/** Creates an organization; the caller becomes its admin and it becomes their active one. */
export async function createOrganizationAction(name: string): Promise<ActionResult> {
  return runSignedInAction(async (user) => {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) return { ok: false, error: "Enter a name for the organization." };
    if (trimmed.length > MAX_NAME_LENGTH) {
      return { ok: false, error: `Use at most ${MAX_NAME_LENGTH} characters.` };
    }
    await createOrganization(getDb(), { name: trimmed, createdBy: user.id });
    revalidateAll();
  });
}

/** Makes one of the caller's organizations the active one; other organizations are refused. */
export async function switchOrganization(organizationId: string): Promise<ActionResult> {
  return runSignedInAction((user) => activate(user.id, organizationId));
}

/**
 * Accepts an invitation to the caller's email and switches to its organization
 * (`organizationId`, which activation rechecks against the caller's memberships).
 */
export async function acceptInvitationAction(
  invitationId: string,
  organizationId: string,
): Promise<ActionResult> {
  return runSignedInAction(async (user) => {
    const result = await acceptInvitation(getDb(), { invitationId, userId: user.id });
    if (result !== "accepted") return { ok: false, error: ACCEPT_ERRORS[result] };
    return activate(user.id, organizationId);
  });
}

/** Declines an invitation to the caller's email. */
export async function declineInvitationAction(invitationId: string): Promise<ActionResult> {
  return runSignedInAction(async (user) => {
    const result = await declineInvitation(getDb(), { invitationId, userId: user.id });
    if (result === "not_found") return { ok: false, error: "That invitation no longer exists." };
    revalidateAll();
  });
}

/**
 * Joins an organization that allows anyone with a matching email to join, as
 * `member`, and switches to it. Whether it's joinable is rechecked here.
 */
export async function joinOrganizationAction(organizationId: string): Promise<ActionResult> {
  return runSignedInAction(async (user) => {
    const result = await joinOrganization(getDb(), { organizationId, userId: user.id });
    if (result === "not_joinable") {
      return { ok: false, error: "You can't join that organization." };
    }
    return activate(user.id, organizationId);
  });
}
