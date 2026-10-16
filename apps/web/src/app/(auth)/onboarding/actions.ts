"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runSignedInAction } from "@/lib/auth/admin-action";
import {
  acceptInvitationFor,
  createOrganizationFor,
  declineInvitationFor,
  joinOrganizationFor,
  switchOrganization,
} from "@/lib/organizations/membership";

/**
 * Onboarding's own handlers (it sits outside the signed-in app shell and its live data):
 * each re-renders every page, which shows the active organization.
 */
async function andRevalidate(result: Promise<ActionResult>): Promise<ActionResult> {
  const settled = await result;
  if (settled.ok) revalidatePath("/", "layout");
  return settled;
}

/** Creates an organization; the caller becomes its admin and it becomes their active one. */
export async function createOrganizationAction(name: string): Promise<ActionResult> {
  return runSignedInAction((user) => andRevalidate(createOrganizationFor(user.id, name)));
}

/** Makes one of the caller's organizations the active one; other organizations are refused. */
export async function switchOrganizationAction(organizationId: string): Promise<ActionResult> {
  return runSignedInAction((user) => andRevalidate(switchOrganization(user.id, organizationId)));
}

/** Accepts an invitation to the caller's email and switches to its organization. */
export async function acceptInvitationAction(
  invitationId: string,
  organizationId: string,
): Promise<ActionResult> {
  return runSignedInAction((user) =>
    andRevalidate(acceptInvitationFor(user.id, invitationId, organizationId)),
  );
}

/** Declines an invitation to the caller's email. */
export async function declineInvitationAction(invitationId: string): Promise<ActionResult> {
  return runSignedInAction((user) => andRevalidate(declineInvitationFor(user.id, invitationId)));
}

/** Joins an organization that allows anyone with a matching email to join, and switches to it. */
export async function joinOrganizationAction(organizationId: string): Promise<ActionResult> {
  return runSignedInAction((user) => andRevalidate(joinOrganizationFor(user.id, organizationId)));
}
