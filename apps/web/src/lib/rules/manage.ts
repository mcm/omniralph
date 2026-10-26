import "server-only";
import {
  createCustomRule,
  deleteRule as deleteRuleRow,
  getRepository,
  getRepositoryRule,
  getRepositoryWithConnection,
  listRepositoryRules,
  updateRule,
  type Database,
} from "@omniralph/db";
import { RuleInput } from "@omniralph/shared";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { ApiRouteError } from "@/lib/api/handler";
import type { RepositoryRules, RuleSaveResult } from "@/lib/api/rules";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { ruleView, type RuleView } from "./display";

export const REPOSITORY_NOT_CONNECTED = "That repository isn't connected.";
export const RULE_NOT_FOUND = "That rule doesn't exist.";

/** The saved rule as the Rules section shows it (with its creator and source finding). */
async function savedRule(
  db: Database,
  repositoryId: string,
  ruleId: string,
): Promise<RuleView | null> {
  const entry = await getRepositoryRule(db, repositoryId, ruleId);
  return entry && ruleView(entry);
}

/** A rule switched on or off; anything else sent to a rule is a text edit (`RuleInput`). */
const EnabledChange = z.object({ enabled: z.boolean() }).strict();

type ActionFailure = Extract<ActionResult, { ok: false }>;

function invalidText(error: z.ZodError): ActionFailure {
  const message = error.issues[0]?.message ?? "Enter the rule.";
  return { ok: false, error: message, fieldErrors: { text: message } };
}

/**
 * Repository › Rules: the organization's connected repository `repositoryId` with its rules
 * (custom first, then learned); a disconnected or missing one is not found.
 */
export async function loadRepositoryRules(
  db: Database,
  organizationId: string,
  repositoryId: string,
): Promise<RepositoryRules> {
  const found = await getRepositoryWithConnection(db, repositoryId, organizationId);
  if (!found || found.repository.disconnectedAt) throw ApiRouteError.notFound();
  const { repository, connection } = found;
  const rules = await listRepositoryRules(db, repositoryId);
  return {
    repository: {
      id: repository.id,
      provider: repository.provider,
      fullPath: repository.fullPath,
      webUrl: repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath),
    },
    rules: rules.map(ruleView),
  };
}

/**
 * Adds an admin-written rule (`RuleInput`); it applies to the next review job of the
 * repository. Answers with the added rule.
 */
export async function addCustomRule(
  db: Database,
  admin: { id: string; organizationId: string },
  repositoryId: string,
  input: unknown,
): Promise<RuleSaveResult | ActionFailure> {
  const parsed = RuleInput.safeParse(input);
  if (!parsed.success) return invalidText(parsed.error);
  const repository = await getRepository(db, repositoryId, admin.organizationId);
  if (!repository || repository.disconnectedAt) {
    return { ok: false, error: REPOSITORY_NOT_CONNECTED };
  }
  const created = await createCustomRule(db, {
    repositoryId,
    text: parsed.data.text,
    createdBy: admin.id,
  });
  const rule = await savedRule(db, repositoryId, created.id);
  return rule ? { ok: true, rule } : { ok: false, error: RULE_NOT_FOUND };
}

/**
 * Changes a custom or learned rule: `{ enabled }` enables or disables it (disabled rules stay
 * listed but aren't sent to reviews), `{ text }` (`RuleInput`) edits it. Answers with the
 * changed rule.
 */
export async function changeRule(
  db: Database,
  organizationId: string,
  repositoryId: string,
  ruleId: string,
  input: unknown,
): Promise<RuleSaveResult | ActionFailure> {
  const enabled = EnabledChange.safeParse(input);
  let change: { text: string } | { enabled: boolean };
  if (enabled.success) change = enabled.data;
  else {
    const parsed = RuleInput.safeParse(input);
    if (!parsed.success) return invalidText(parsed.error);
    change = parsed.data;
  }
  if (!(await getRepository(db, repositoryId, organizationId))) {
    return { ok: false, error: RULE_NOT_FOUND };
  }
  const updated = await updateRule(db, { repositoryId, ruleId, ...change });
  const rule = updated && (await savedRule(db, repositoryId, updated.id));
  return rule ? { ok: true, rule } : { ok: false, error: RULE_NOT_FOUND };
}

/** Deletes a rule. */
export async function removeRule(
  db: Database,
  organizationId: string,
  repositoryId: string,
  ruleId: string,
): Promise<ActionResult> {
  if (!(await getRepository(db, repositoryId, organizationId))) {
    return { ok: false, error: RULE_NOT_FOUND };
  }
  return (await deleteRuleRow(db, { repositoryId, ruleId }))
    ? { ok: true }
    : { ok: false, error: RULE_NOT_FOUND };
}
