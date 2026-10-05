import "server-only";
import type { ActionResult } from "@/lib/action-result";
import { AuthorizationError } from "./roles";
import { requireUser, type CurrentUser } from "./session";

/**
 * Runs a mutating server action as an admin. Every server action that changes settings,
 * repos, agents or users goes through this: non-admins (and signed-out callers) get an
 * error result and `fn` never runs.
 */
export async function runAdminAction(
  fn: (admin: CurrentUser) => Promise<ActionResult | void>,
): Promise<ActionResult> {
  let admin: CurrentUser;
  try {
    admin = await requireUser("admin");
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: error.message };
    throw error;
  }
  return (await fn(admin)) ?? { ok: true };
}

/**
 * Runs a mutating server action as any signed-in member (e.g. dismissing a
 * finding); signed-out callers get an error result and `fn` never runs.
 */
export async function runMemberAction(
  fn: (user: CurrentUser) => Promise<ActionResult | void>,
): Promise<ActionResult> {
  let user: CurrentUser;
  try {
    user = await requireUser("member");
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: error.message };
    throw error;
  }
  return (await fn(user)) ?? { ok: true };
}
