import "server-only";
import {
  acceptInvitation,
  createOrganization,
  declineInvitation,
  joinOrganization,
  type AcceptInvitationResult,
} from "@omniralph/db";
import type { ActionResult } from "@/lib/action-result";
import { getDb } from "@/lib/db";
import { activateOrganization } from "./active";
import { checkOrganizationName } from "./name";

/**
 * Creating, switching, accepting, declining and joining organizations, for any signed-in
 * user (with or without an organization): shared by the organization switcher's
 * `/api/ui/organizations/switch` and onboarding's server actions.
 */

const ACCEPT_ERRORS: Record<Exclude<AcceptInvitationResult, "accepted">, string> = {
  not_found: "That invitation no longer exists.",
  expired: "That invitation has expired. Ask an admin to invite you again.",
  revoked: "That invitation was revoked.",
  already_accepted: "That invitation was already accepted.",
  email_mismatch: "That invitation is for another email address.",
  email_not_allowed: "Your email domain is no longer allowed in that organization.",
};

/** Makes one of the user's organizations the active one; other organizations are refused. */
export async function switchOrganization(
  userId: string,
  organizationId: string,
): Promise<ActionResult> {
  if (!(await activateOrganization(userId, organizationId))) {
    return { ok: false, error: "You are not a member of that organization." };
  }
  return { ok: true };
}

/** Creates an organization; the user becomes its admin and it becomes their active one. */
export async function createOrganizationFor(userId: string, name: string): Promise<ActionResult> {
  const checked = checkOrganizationName(name);
  if ("error" in checked) return { ok: false, error: checked.error };
  const organization = await createOrganization(getDb(), { name: checked.name, createdBy: userId });
  return switchOrganization(userId, organization.id);
}

/**
 * Accepts an invitation to the user's email and switches to its organization
 * (`organizationId`, which activation rechecks against the user's memberships).
 */
export async function acceptInvitationFor(
  userId: string,
  invitationId: string,
  organizationId: string,
): Promise<ActionResult> {
  const result = await acceptInvitation(getDb(), { invitationId, userId });
  if (result !== "accepted") return { ok: false, error: ACCEPT_ERRORS[result] };
  return switchOrganization(userId, organizationId);
}

/** Declines an invitation to the user's email. */
export async function declineInvitationFor(
  userId: string,
  invitationId: string,
): Promise<ActionResult> {
  const result = await declineInvitation(getDb(), { invitationId, userId });
  if (result === "not_found") return { ok: false, error: "That invitation no longer exists." };
  return { ok: true };
}

/**
 * Joins an organization that allows anyone with a matching email to join, as `member`,
 * and switches to it. Whether it's joinable is rechecked here.
 */
export async function joinOrganizationFor(
  userId: string,
  organizationId: string,
): Promise<ActionResult> {
  const result = await joinOrganization(getDb(), { organizationId, userId });
  if (result === "not_joinable") return { ok: false, error: "You can't join that organization." };
  return switchOrganization(userId, organizationId);
}
