/**
 * Host tools: software agent owners install by hand (e.g. opengrep). Each
 * agent sets their paths locally (`settings.json`) and reports every tool it
 * configured or was asked about (`requiredHostTools`) in its heartbeat, stored
 * read-only in `agents.reported_host_tools`. A reported tool with a `path` is
 * usable; one without isn't (not found, or a configured path that's missing,
 * not executable or blocked). Every helper is scoped to one organization.
 */
import { HOST_TOOL_NAME_PATTERN, type HostToolReport } from "@omniralph/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { agents, playbooks } from "./schema.js";

/** Most host tool names a heartbeat response asks about (as the protocol allows). */
const MAX_REQUIRED_HOST_TOOLS = 100;

/**
 * The host tools the organization's playbooks require (their stored
 * `requirements.hostTools`), sorted and de-duplicated: the heartbeat
 * response's `requiredHostTools`. Built-in playbooks require none.
 */
export async function listRequiredHostTools(
  db: Database,
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({
      name: sql<string>`jsonb_array_elements_text(${playbooks.requirements} -> 'hostTools')`,
    })
    .from(playbooks)
    .where(
      and(
        eq(playbooks.organizationId, organizationId),
        sql`jsonb_typeof(${playbooks.requirements} -> 'hostTools') = 'array'`,
      ),
    );
  return rows
    .map((row) => row.name)
    .filter((name) => HOST_TOOL_NAME_PATTERN.test(name))
    .sort()
    .slice(0, MAX_REQUIRED_HOST_TOOLS);
}

/** The names of the reported host tools with a path, sorted and de-duplicated. */
export function usableHostToolNames(reported: readonly HostToolReport[] | null): string[] {
  return [
    ...new Set((reported ?? []).filter((tool) => tool.path !== null).map((tool) => tool.name)),
  ].sort();
}

/**
 * The names of the reported host tools without a path among `required`, sorted: what a
 * playbook needs that the agent can't run.
 */
export function missingHostToolNames(
  reported: readonly HostToolReport[] | null,
  required: readonly string[],
): string[] {
  const usable = new Set(usableHostToolNames(reported));
  return [...new Set(required.filter((name) => !usable.has(name)))].sort();
}

/**
 * The host tool names the playbook editor suggests: the ones the organization's
 * non-revoked agents report with a path and the ones its playbooks require,
 * sorted and de-duplicated.
 */
export async function listHostToolSuggestions(
  db: Database,
  organizationId: string,
): Promise<string[]> {
  const [usable, required] = await Promise.all([
    listAgentsUsableHostTools(db, organizationId),
    listRequiredHostTools(db, organizationId),
  ]);
  return [...new Set([...[...usable.values()].flat(), ...required])].sort();
}

/**
 * For each of the organization's non-revoked agents (only `agentIds` when given) that
 * reports at least one usable host tool, their names (`usableHostToolNames`): what
 * `claimJob` checks a job's `required_host_tools` against.
 */
export async function listAgentsUsableHostTools(
  db: Database,
  organizationId: string,
  agentIds?: readonly string[],
): Promise<Map<string, string[]>> {
  const usable = new Map<string, string[]>();
  if (agentIds?.length === 0) return usable;
  const rows = await db
    .select({ id: agents.id, hostTools: agents.reportedHostTools })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, organizationId),
        isNull(agents.revokedAt),
        isNull(agents.deletedAt),
        agentIds ? inArray(agents.id, [...agentIds]) : undefined,
      ),
    );
  for (const row of rows) {
    const names = usableHostToolNames(row.hostTools);
    if (names.length > 0) usable.set(row.id, names);
  }
  return usable;
}
