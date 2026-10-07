import "server-only";
import type { ActionResult } from "@/lib/action-result";
import { AuthorizationError } from "./roles";
import { requireSignedInUser, requireUser, type CurrentUser, type OrgUser } from "./session";

/**
 * Runs a mutating server action as an admin of the active organization. Every server
 * action that changes settings, repos, agents or members goes through this: non-admins
 * (and signed-out callers, or users without an organization) get an error result and
 * `fn` never runs. `fn` may return a result with extra fields (e.g. a created ID).
 */
export async function runAdminAction<R extends ActionResult = ActionResult>(
  fn: (admin: OrgUser) => Promise<R | void>,
): Promise<R | ActionResult> {
  let admin: OrgUser;
  try {
    admin = await requireUser("admin");
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: error.message };
    throw error;
  }
  return (await fn(admin)) ?? { ok: true };
}

/**
 * Runs a mutating server action as any member of the active organization (e.g.
 * dismissing a finding); other callers get an error result and `fn` never runs.
 */
export async function runMemberAction(
  fn: (user: OrgUser) => Promise<ActionResult | void>,
): Promise<ActionResult> {
  let user: OrgUser;
  try {
    user = await requireUser("member");
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: error.message };
    throw error;
  }
  return (await fn(user)) ?? { ok: true };
}

/**
 * Runs a server action as any signed-in user, with or without an organization
 * (creating, joining or switching organizations); signed-out callers get an error
 * result and `fn` never runs.
 */
export async function runSignedInAction(
  fn: (user: CurrentUser) => Promise<ActionResult | void>,
): Promise<ActionResult> {
  let user: CurrentUser;
  try {
    user = await requireSignedInUser();
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: error.message };
    throw error;
  }
  return (await fn(user)) ?? { ok: true };
}
