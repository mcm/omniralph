/**
 * Host tools: an organization's catalog of software harness owners install by
 * hand, and per harness the path an admin configured and what the harness
 * reported for it. Every admin helper is scoped to one organization: a row of
 * another organization is never read or written.
 */
import { HOST_TOOL_NAME_PATTERN, type ReportedHostTool } from "@omniralph/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { harnessHostTools, harnesses, hostTools } from "./schema.js";

export type HostTool = typeof hostTools.$inferSelect;
export type HarnessHostToolRow = typeof harnessHostTools.$inferSelect;

/** Longest configured path accepted (as the heartbeat protocol). */
const MAX_PATH_LENGTH = 4096;

export function isValidHostToolName(name: string): boolean {
  return HOST_TOOL_NAME_PATTERN.test(name);
}

export function isValidHostToolPath(path: string): boolean {
  return path.startsWith("/") && path.length <= MAX_PATH_LENGTH;
}

/**
 * The path a harness runs a host tool from: the configured path when one is
 * set and the harness found it usable (none when it didn't, or hasn't reported
 * yet: no fallback), else the path it discovered on its `PATH`, else none.
 */
export function effectiveHostToolPath(
  row: Pick<HarnessHostToolRow, "configuredPath" | "configuredPathExists" | "discoveredPath">,
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
  return row ? { ok: true, hostTool: row } : { ok: false, error: "duplicate_name" };
}

/** The organization's host tools, by name. */
export async function listHostTools(db: Database, organizationId: string): Promise<HostTool[]> {
  return db
    .select()
    .from(hostTools)
    .where(eq(hostTools.organizationId, organizationId))
    .orderBy(asc(hostTools.name));
}

/** Removes a host tool (and every harness's path for it). False when the organization has no such tool. */
export async function deleteHostTool(
  db: Database,
  organizationId: string,
  hostToolId: string,
): Promise<boolean> {
  const rows = await db
    .delete(hostTools)
    .where(and(eq(hostTools.organizationId, organizationId), eq(hostTools.id, hostToolId)))
    .returning({ id: hostTools.id });
  return rows.length > 0;
}

/** A catalog host tool on one harness: its configured path and the harness's last report. */
export interface HarnessHostTool {
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
 * Every host tool of the harness's organization with that harness's configured
 * path and report (none for tools it has no row for), by name. Empty for an
 * unknown harness or one of another organization.
 */
export async function listHarnessHostTools(
  db: Database,
  organizationId: string,
  harnessId: string,
): Promise<HarnessHostTool[]> {
  const rows = await db
    .select({
      hostToolId: hostTools.id,
      name: hostTools.name,
      description: hostTools.description,
      configuredPath: harnessHostTools.configuredPath,
      configuredPathExists: harnessHostTools.configuredPathExists,
      discoveredPath: harnessHostTools.discoveredPath,
      reportedAt: harnessHostTools.reportedAt,
    })
    .from(hostTools)
    .innerJoin(
      harnesses,
      and(eq(harnesses.id, harnessId), eq(harnesses.organizationId, hostTools.organizationId)),
    )
    .leftJoin(
      harnessHostTools,
      and(eq(harnessHostTools.hostToolId, hostTools.id), eq(harnessHostTools.harnessId, harnessId)),
    )
    .where(eq(hostTools.organizationId, organizationId))
    .orderBy(asc(hostTools.name));
  return rows.map((row) => ({ ...row, effectivePath: effectiveHostToolPath(row) }));
}

export type SetHarnessHostToolPathResult =
  { ok: true } | { ok: false; error: "invalid_path" | "not_found" };

/**
 * Sets (or, with null, clears) the path a harness runs a host tool from. The
 * last report on the configured path is cleared, since it was about another
 * path: the tool is unavailable until the harness reports on the new one.
 * `not_found` for an unknown or revoked harness, an unknown tool, or either of
 * another organization.
 */
export async function setHarnessHostToolPath(
  db: Database,
  organizationId: string,
  harnessId: string,
  hostToolId: string,
  configuredPath: string | null,
): Promise<SetHarnessHostToolPathResult> {
  if (configuredPath !== null && !isValidHostToolPath(configuredPath)) {
    return { ok: false, error: "invalid_path" };
  }
  const [target] = await db
    .select({ harnessId: harnesses.id, hostToolId: hostTools.id })
    .from(harnesses)
    .innerJoin(
      hostTools,
      and(eq(hostTools.id, hostToolId), eq(hostTools.organizationId, harnesses.organizationId)),
    )
    .where(
      and(
        eq(harnesses.id, harnessId),
        eq(harnesses.organizationId, organizationId),
        sql`${harnesses.revokedAt} is null`,
      ),
    );
  if (!target) return { ok: false, error: "not_found" };
  await db
    .insert(harnessHostTools)
    .values({ harnessId, hostToolId, configuredPath, configuredPathExists: null })
    .onConflictDoUpdate({
      target: [harnessHostTools.harnessId, harnessHostTools.hostToolId],
      set: { configuredPath, configuredPathExists: null },
    });
  return { ok: true };
}

/**
 * Stores a harness's heartbeat report on its organization's host tools
 * (creating rows as needed). Names not in the catalog are ignored and the
 * configured paths are left as they are. `configuredPathExists` is only kept
 * when it's about the configured path stored now: null when none is
 * configured, or when the harness says it checked another one (the path
 * changed since its last heartbeat response).
 */
export async function recordHarnessHostTools(
  db: Database,
  organizationId: string,
  harnessId: string,
  reported: readonly ReportedHostTool[],
  now: Date = new Date(),
): Promise<void> {
  if (reported.length === 0) return;
  const known = await db
    .select({
      id: hostTools.id,
      name: hostTools.name,
      configuredPath: harnessHostTools.configuredPath,
    })
    .from(hostTools)
    .leftJoin(
      harnessHostTools,
      and(eq(harnessHostTools.hostToolId, hostTools.id), eq(harnessHostTools.harnessId, harnessId)),
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
  const values = new Map<string, typeof harnessHostTools.$inferInsert>();
  for (const tool of reported) {
    const entry = catalog.get(tool.name);
    if (!entry) continue;
    const current =
      entry.configuredPath !== null &&
      (tool.configuredPath === undefined || tool.configuredPath === entry.configuredPath);
    values.set(entry.id, {
      harnessId,
      hostToolId: entry.id,
      configuredPathExists: current ? tool.configuredPathExists : null,
      discoveredPath: tool.discoveredPath,
      reportedAt: now,
    });
  }
  if (values.size === 0) return;
  await db
    .insert(harnessHostTools)
    .values([...values.values()])
    .onConflictDoUpdate({
      target: [harnessHostTools.harnessId, harnessHostTools.hostToolId],
      set: {
        configuredPathExists: sql`excluded.configured_path_exists`,
        discoveredPath: sql`excluded.discovered_path`,
        reportedAt: sql`excluded.reported_at`,
      },
    });
}
