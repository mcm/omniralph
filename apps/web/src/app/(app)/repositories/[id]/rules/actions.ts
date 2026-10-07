"use server";

import {
  createCustomRule,
  deleteRule as deleteRuleRow,
  getRepository,
  updateRule,
} from "@omniralph/db";
import { RuleInput } from "@omniralph/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import type { OrgUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

const Id = z.uuid();
const NOT_CONNECTED = "That repository isn't connected.";
const NO_RULE = "That rule doesn't exist.";

function invalidText(error: z.ZodError): ActionResult {
  const message = error.issues[0]?.message ?? "Enter the rule.";
  return { ok: false, error: message, fieldErrors: { text: message } };
}

/** Whether the repository is one of the admin's active organization. */
async function inOrganization(admin: OrgUser, repositoryId: string): Promise<boolean> {
  return (await getRepository(getDb(), repositoryId, admin.organization.id)) !== null;
}

function revalidate(repositoryId: string) {
  revalidatePath(`/repositories/${repositoryId}/rules`);
}

/** Adds an admin-written rule; it applies to the next review job of the repository. */
export async function addCustomRule(repositoryId: string, input: RuleInput): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const parsed = RuleInput.safeParse(input);
    if (!parsed.success) return invalidText(parsed.error);
    if (!Id.safeParse(repositoryId).success) return { ok: false, error: NOT_CONNECTED };
    const db = getDb();
    const repository = await getRepository(db, repositoryId, admin.organization.id);
    if (!repository || repository.disconnectedAt) return { ok: false, error: NOT_CONNECTED };
    await createCustomRule(db, { repositoryId, text: parsed.data.text, createdBy: admin.id });
    revalidate(repositoryId);
  });
}

/** Edits a custom or learned rule's text. */
export async function editRule(
  repositoryId: string,
  ruleId: string,
  input: RuleInput,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const parsed = RuleInput.safeParse(input);
    if (!parsed.success) return invalidText(parsed.error);
    if (!Id.safeParse(repositoryId).success || !Id.safeParse(ruleId).success) {
      return { ok: false, error: NO_RULE };
    }
    if (!(await inOrganization(admin, repositoryId))) return { ok: false, error: NO_RULE };
    const rule = await updateRule(getDb(), { repositoryId, ruleId, text: parsed.data.text });
    if (!rule) return { ok: false, error: NO_RULE };
    revalidate(repositoryId);
  });
}

/** Enables or disables a rule; disabled rules stay listed but aren't sent to reviews. */
export async function setRuleEnabled(
  repositoryId: string,
  ruleId: string,
  enabled: boolean,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (!Id.safeParse(repositoryId).success || !Id.safeParse(ruleId).success) {
      return { ok: false, error: NO_RULE };
    }
    if (!(await inOrganization(admin, repositoryId))) return { ok: false, error: NO_RULE };
    const rule = await updateRule(getDb(), { repositoryId, ruleId, enabled: enabled === true });
    if (!rule) return { ok: false, error: NO_RULE };
    revalidate(repositoryId);
  });
}

/** Deletes a rule. */
export async function deleteRule(repositoryId: string, ruleId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (!Id.safeParse(repositoryId).success || !Id.safeParse(ruleId).success) {
      return { ok: false, error: NO_RULE };
    }
    if (!(await inOrganization(admin, repositoryId))) return { ok: false, error: NO_RULE };
    if (!(await deleteRuleRow(getDb(), { repositoryId, ruleId }))) {
      return { ok: false, error: NO_RULE };
    }
    revalidate(repositoryId);
  });
}
