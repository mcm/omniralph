/** Helpers for ralph tests: coding playbooks with their own coding settings, and a fake Linear workspace. */
import { eq } from "drizzle-orm";
import { insertPlaybook, repositories, type Database } from "@omniralph/db";
import { getBuiltinPlaybook, type Playbook, type PlaybookCoding } from "@omniralph/tasks";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";

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

/**
 * The ralph orchestrator's Linear workspace for tests (`RalphDeps.linear`): a fake one, for
 * tests of modules that don't import from `@/lib/tracker/` or `@omniralph/tracker` themselves (the chat).
 */
export function fakeRalphLinear(): FakeLinearGateway {
  return new FakeLinearGateway();
}
