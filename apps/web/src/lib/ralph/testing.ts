/** Helpers for ralph tests: coding playbooks with their own coding settings. */
import { eq } from "drizzle-orm";
import { insertPlaybook, repositories, type Database } from "@omniralph/db";
import { getBuiltinPlaybook, type Playbook, type PlaybookCoding } from "@omniralph/tasks";

/**
 * Binds `repositoryId` to a copy of its built-in story (or request) playbook with `coding`
 * settings (and any other `fields`, e.g. its model), stored for the organization; returns the
 * playbook's ID.
 */
export async function bindCodingPlaybook(
  db: Database,
  organizationId: string,
  repositoryId: string,
  role: "story" | "request",
  coding: PlaybookCoding,
  fields: Partial<Pick<Playbook, "model" | "fallbackModel">> = {},
): Promise<string> {
  const builtin = role === "story" ? "builtin:implement-story" : "builtin:handle-request";
  const { id: _id, name, role: _role, ...definition } = getBuiltinPlaybook(builtin)!;
  const row = await insertPlaybook(db, organizationId, {
    name: `${name} (test)`,
    role,
    definition: { ...definition, ...fields, coding: { ...definition.coding, ...coding } },
    requirements: {},
    createdBy: null,
  });
  await db
    .update(repositories)
    .set(role === "story" ? { storyPlaybookId: row.id } : { requestPlaybookId: row.id })
    .where(eq(repositories.id, repositoryId));
  return row.id;
}

/** Binds `repositoryId` back to the built-in story and request playbooks. */
export async function bindBuiltinPlaybooks(db: Database, repositoryId: string): Promise<void> {
  await db
    .update(repositories)
    .set({
      storyPlaybookId: "builtin:implement-story",
      requestPlaybookId: "builtin:handle-request",
    })
    .where(eq(repositories.id, repositoryId));
}
