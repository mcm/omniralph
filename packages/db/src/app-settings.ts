/** Instance-wide settings (`app_settings`): one JSON value per key. */
import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { appSettings } from "./schema.js";

/** The version every agent should run unless it has its own override; a string or absent. */
export const DESIRED_AGENT_VERSION_KEY = "agent.desiredVersion";

export interface AppSetting<T> {
  value: T;
  updatedBy: string | null;
  updatedAt: Date;
}

export async function getAppSetting(
  db: Database,
  key: string,
): Promise<AppSetting<unknown> | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return row ? { value: row.value, updatedBy: row.updatedBy, updatedAt: row.updatedAt } : null;
}

/** Stores a setting; `null` removes it. */
export async function setAppSetting(
  db: Database,
  key: string,
  value: unknown,
  updatedBy: string | null,
): Promise<void> {
  if (value === null) {
    await db.delete(appSettings).where(eq(appSettings.key, key));
    return;
  }
  await db
    .insert(appSettings)
    .values({ key, value, updatedBy })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedBy, updatedAt: new Date() },
    });
}

/** The global desired agent version, or null when none is chosen. */
export async function getDesiredAgentVersion(db: Database): Promise<string | null> {
  const setting = await getAppSetting(db, DESIRED_AGENT_VERSION_KEY);
  return typeof setting?.value === "string" ? setting.value : null;
}

/** Sets (or, with null, clears) the global desired agent version. */
export async function setDesiredAgentVersion(
  db: Database,
  version: string | null,
  updatedBy: string | null,
): Promise<void> {
  await setAppSetting(db, DESIRED_AGENT_VERSION_KEY, version, updatedBy);
}
