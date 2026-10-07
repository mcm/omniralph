/** Per-organization settings (`app_settings`): one JSON value per organization and key. */
import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { appSettings } from "./schema.js";

/** The version every agent of the organization should run unless it has its own override; a string or absent. */
export const DESIRED_AGENT_VERSION_KEY = "agent.desiredVersion";

export interface AppSetting<T> {
  value: T;
  updatedBy: string | null;
  updatedAt: Date;
}

export async function getAppSetting(
  db: Database,
  organizationId: string,
  key: string,
): Promise<AppSetting<unknown> | null> {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(and(eq(appSettings.organizationId, organizationId), eq(appSettings.key, key)))
    .limit(1);
  return row ? { value: row.value, updatedBy: row.updatedBy, updatedAt: row.updatedAt } : null;
}

/** Stores an organization's setting; `null` removes it. */
export async function setAppSetting(
  db: Database,
  organizationId: string,
  key: string,
  value: unknown,
  updatedBy: string | null,
): Promise<void> {
  if (value === null) {
    await db
      .delete(appSettings)
      .where(and(eq(appSettings.organizationId, organizationId), eq(appSettings.key, key)));
    return;
  }
  await db
    .insert(appSettings)
    .values({ organizationId, key, value, updatedBy })
    .onConflictDoUpdate({
      target: [appSettings.organizationId, appSettings.key],
      set: { value, updatedBy, updatedAt: new Date() },
    });
}

/** The organization's desired agent version, or null when none is chosen. */
export async function getDesiredAgentVersion(
  db: Database,
  organizationId: string,
): Promise<string | null> {
  const setting = await getAppSetting(db, organizationId, DESIRED_AGENT_VERSION_KEY);
  return typeof setting?.value === "string" ? setting.value : null;
}

/** Sets (or, with null, clears) the organization's desired agent version. */
export async function setDesiredAgentVersion(
  db: Database,
  organizationId: string,
  version: string | null,
  updatedBy: string | null,
): Promise<void> {
  await setAppSetting(db, organizationId, DESIRED_AGENT_VERSION_KEY, version, updatedBy);
}
