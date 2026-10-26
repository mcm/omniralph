/**
 * Host tools: an organization's catalog of software agent owners install by
 * hand, and per agent the path an admin configured and what the agent
 * reported for it. Every admin helper is scoped to one organization: a row of
 * another organization is never read or written.
 */
import { HOST_TOOL_NAME_PATTERN, type ReportedHostTool } from "@omniralph/shared";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import { agentHostTools, agents, hostTools } from "./schema.js";

export type HostTool = typeof hostTools.$inferSelect;
export type AgentHostToolRow = typeof agentHostTools.$inferSelect;

/** Longest configured path accepted (as the heartbeat protocol). */
const MAX_PATH_LENGTH = 4096;

export function isValidHostToolName(name: string): boolean {
  return HOST_TOOL_NAME_PATTERN.test(name);
}

export function isValidHostToolPath(path: string): boolean {
  return path.startsWith("/") && path.length <= MAX_PATH_LENGTH;
}

/**
 * The path an agent runs a host tool from: the configured path when one is
 * set and the agent found it usable (none when it didn't, or hasn't reported
 * yet: no fallback), else the path it discovered on its `PATH`, else none.
 */
export function effectiveHostToolPath(
  row: Pick<AgentHostToolRow, "configuredPath" | "configuredPathExists" | "discoveredPath">,
): string | null {
  if (row.configuredPath !== null) {
    return row.configuredPathExists === true ? row.configuredPath : null;
  }
  return row.discoveredPath;
}

export type CreateHostToolResult =
  { ok: true; hostTool: HostTool } | { ok: false; error: "invalid_name" | "duplicate_name" };

/** Adds a host tool to the organization's catalog. */
export async function createHostTool(
  db: Database,
  organizationId: string,
  input: { name: string; description?: string | null },
): Promise<CreateHostToolResult> {
  if (!isValidHostToolName(input.name)) return { ok: false, error: "invalid_name" };
  const [row] = await db
    .insert(hostTools)
    .values({ organizationId, name: input.name, description: input.description ?? null })
    .onConflictDoNothing({ target: [hostTools.organizationId, hostTools.name] })
    .returning();
  if (row) recordHostToolCatalogChange(db, organizationId);
  return row ? { ok: true, hostTool: row } : { ok: false, error: "duplicate_name" };
}

/** The host tool catalog is part of the agent defaults (a live `settings` change). */
function recordHostToolCatalogChange(db: Database, organizationId: string): void {
  recordChange(db, {
    resource: "settings",
    section: "agent_defaults",
    ids: [organizationId],
    organizationId,
  });
}

/** The organization's host tools, by name. */
export async function listHostTools(db: Database, organizationId: string): Promise<HostTool[]> {
  return db
    .select()
    .from(hostTools)
    .where(eq(hostTools.organizationId, organizationId))
    .orderBy(asc(hostTools.name));
}

/** Removes a host tool (and every agent's path for it). False when the organization has no such tool. */
export async function deleteHostTool(
  db: Database,
  organizationId: string,
  hostToolId: string,
): Promise<boolean> {
  const rows = await db
    .delete(hostTools)
    .where(and(eq(hostTools.organizationId, organizationId), eq(hostTools.id, hostToolId)))
    .returning({ id: hostTools.id });
  if (rows.length > 0) recordHostToolCatalogChange(db, organizationId);
  return rows.length > 0;
}

/** A catalog host tool on one agent: its configured path and the agent's last report. */
export interface AgentHostTool {
  hostToolId: string;
  name: string;
  description: string | null;
  configuredPath: string | null;
  configuredPathExists: boolean | null;
  discoveredPath: string | null;
  reportedAt: Date | null;
  /** `effectiveHostToolPath()` of the row. */
  effectivePath: string | null;
}

/**
 * Every host tool of the agent's organization with that agent's configured
 * path and report (none for tools it has no row for), by name. Empty for an
 * unknown agent or one of another organization.
 */
export async function listAgentHostTools(
  db: Database,
  organizationId: string,
  agentId: string,
): Promise<AgentHostTool[]> {
  const rows = await db
    .select({
      hostToolId: hostTools.id,
      name: hostTools.name,
      description: hostTools.description,
      configuredPath: agentHostTools.configuredPath,
      configuredPathExists: agentHostTools.configuredPathExists,
      discoveredPath: agentHostTools.discoveredPath,
      reportedAt: agentHostTools.reportedAt,
    })
    .from(hostTools)
    .innerJoin(
      agents,
      and(eq(agents.id, agentId), eq(agents.organizationId, hostTools.organizationId)),
    )
    .leftJoin(
      agentHostTools,
      and(eq(agentHostTools.hostToolId, hostTools.id), eq(agentHostTools.agentId, agentId)),
    )
    .where(eq(hostTools.organizationId, organizationId))
    .orderBy(asc(hostTools.name));
  return rows.map((row) => ({ ...row, effectivePath: effectiveHostToolPath(row) }));
}

/**
 * For each of the organization's agents with at least one, the names of the
 * host tools it has an `effectiveHostToolPath` for, sorted: what `claimJob`
 * checks a job's `required_host_tools` against.
 */
export async function listAgentsUsableHostTools(
  db: Database,
  organizationId: string,
): Promise<Map<string, string[]>> {
  const rows = await db
    .select({
      agentId: agentHostTools.agentId,
      name: hostTools.name,
      configuredPath: agentHostTools.configuredPath,
      configuredPathExists: agentHostTools.configuredPathExists,
      discoveredPath: agentHostTools.discoveredPath,
    })
    .from(agentHostTools)
    .innerJoin(hostTools, eq(hostTools.id, agentHostTools.hostToolId))
    .innerJoin(
      agents,
      and(
        eq(agents.id, agentHostTools.agentId),
        eq(agents.organizationId, hostTools.organizationId),
      ),
    )
    .where(eq(hostTools.organizationId, organizationId))
    .orderBy(asc(hostTools.name));
  const usable = new Map<string, string[]>();
  for (const row of rows) {
    if (effectiveHostToolPath(row) === null) continue;
    usable.set(row.agentId, [...(usable.get(row.agentId) ?? []), row.name]);
  }
  return usable;
}

export type SetAgentHostToolPathResult =
  { ok: true } | { ok: false; error: "invalid_path" | "not_found" };

/**
 * Sets (or, with null, clears) the path an agent runs a host tool from. The
 * last report on the configured path is cleared, since it was about another
 * path: the tool is unavailable until the agent reports on the new one.
 * `not_found` for an unknown or revoked agent, an unknown tool, or either of
 * another organization.
 */
export async function setAgentHostToolPath(
  db: Database,
  organizationId: string,
  agentId: string,
  hostToolId: string,
  configuredPath: string | null,
): Promise<SetAgentHostToolPathResult> {
  if (configuredPath !== null && !isValidHostToolPath(configuredPath)) {
    return { ok: false, error: "invalid_path" };
  }
  const [target] = await db
    .select({ agentId: agents.id, hostToolId: hostTools.id })
    .from(agents)
    .innerJoin(
      hostTools,
      and(eq(hostTools.id, hostToolId), eq(hostTools.organizationId, agents.organizationId)),
    )
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.organizationId, organizationId),
        sql`${agents.revokedAt} is null`,
      ),
    );
  if (!target) return { ok: false, error: "not_found" };
  await db
    .insert(agentHostTools)
    .values({ agentId, hostToolId, configuredPath, configuredPathExists: null })
    .onConflictDoUpdate({
      target: [agentHostTools.agentId, agentHostTools.hostToolId],
      set: { configuredPath, configuredPathExists: null },
    });
  recordChange(db, { resource: "agent", ids: [agentId], organizationId });
  return { ok: true };
}

/**
 * Stores an agent's heartbeat report on its organization's host tools
 * (creating rows as needed). Names not in the catalog are ignored and the
 * configured paths are left as they are. `configuredPathExists` is only kept
 * when it's about the configured path stored now: null when none is
 * configured, or when the agent says it checked another one (the path
 * changed since its last heartbeat response). The report is the agent's
 * whole state: a tool it has a row for but left out (an empty report included)
 * is stored as not found, its configured path kept.
 */
export async function recordAgentHostTools(
  db: Database,
  organizationId: string,
  agentId: string,
  reported: readonly ReportedHostTool[],
  now: Date = new Date(),
): Promise<void> {
  const known = await db
    .select({
      id: hostTools.id,
      name: hostTools.name,
      configuredPath: agentHostTools.configuredPath,
    })
    .from(hostTools)
    .leftJoin(
      agentHostTools,
      and(eq(agentHostTools.hostToolId, hostTools.id), eq(agentHostTools.agentId, agentId)),
    )
    .where(
      and(
        eq(hostTools.organizationId, organizationId),
        inArray(
          hostTools.name,
          reported.map((tool) => tool.name),
        ),
      ),
    );
  const catalog = new Map(known.map((tool) => [tool.name, tool]));
  const values = new Map<string, typeof agentHostTools.$inferInsert>();
  for (const tool of reported) {
    const entry = catalog.get(tool.name);
    if (!entry) continue;
    const current =
      entry.configuredPath !== null &&
      (tool.configuredPath === undefined || tool.configuredPath === entry.configuredPath);
    values.set(entry.id, {
      agentId,
      hostToolId: entry.id,
      configuredPathExists: current ? tool.configuredPathExists : null,
      discoveredPath: tool.discoveredPath,
      reportedAt: now,
    });
  }
  await db
    .update(agentHostTools)
    .set({ configuredPathExists: null, discoveredPath: null, reportedAt: now })
    .where(
      and(
        eq(agentHostTools.agentId, agentId),
        notInArray(agentHostTools.hostToolId, [...values.keys()]),
      ),
    );
  if (values.size === 0) return;
  await db
    .insert(agentHostTools)
    .values([...values.values()])
    .onConflictDoUpdate({
      target: [agentHostTools.agentId, agentHostTools.hostToolId],
      set: {
        configuredPathExists: sql`excluded.configured_path_exists`,
        discoveredPath: sql`excluded.discovered_path`,
        reportedAt: sql`excluded.reported_at`,
      },
    });
}
