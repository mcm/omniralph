/** Per-organization settings (`app_settings`): one JSON value per organization and key. */
import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { appSettings } from "./schema.js";

/**
 * The version every harness of the organization should run unless it has its own override: a
 * version, `latest` (`TRACK_LATEST_HARNESS_VERSION`: the package's `latest` on npm) or absent.
 */
export const DESIRED_HARNESS_VERSION_KEY = "harness.desiredVersion";

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

/** The organization's desired harness version (possibly `latest`), or null when none is chosen. */
export async function getDesiredHarnessVersion(
  db: Database,
  organizationId: string,
): Promise<string | null> {
  const setting = await getAppSetting(db, organizationId, DESIRED_HARNESS_VERSION_KEY);
  return typeof setting?.value === "string" ? setting.value : null;
}

/** Sets (or, with null, clears) the organization's desired harness version. */
export async function setDesiredHarnessVersion(
  db: Database,
  organizationId: string,
  version: string | null,
  updatedBy: string | null,
): Promise<void> {
  await setAppSetting(db, organizationId, DESIRED_HARNESS_VERSION_KEY, version, updatedBy);
}

/** The organization's desired harness version when its harnesses follow the package's `latest` on npm. */
export const TRACK_LATEST_HARNESS_VERSION = "latest";

/**
 * The `latest` version last read from npm for an organization that tracks it
 * (`{ version, error }`; `updatedAt` is when it was read). Kept in the database
 * so every control panel instance hands harnesses the same version.
 */
export const LATEST_HARNESS_VERSION_KEY = "harness.latestVersion";

export interface LatestHarnessVersionCheck {
  /** The last version read, kept when a later read failed; null when none was read yet. */
  version: string | null;
  /** Why the last read failed, or null. */
  error: string | null;
  checkedAt: Date;
}

export async function getLatestHarnessVersionCheck(
  db: Database,
  organizationId: string,
): Promise<LatestHarnessVersionCheck | null> {
  const setting = await getAppSetting(db, organizationId, LATEST_HARNESS_VERSION_KEY);
  if (!setting || typeof setting.value !== "object" || setting.value === null) return null;
  const { version, error } = setting.value as { version?: unknown; error?: unknown };
  return {
    version: typeof version === "string" ? version : null,
    error: typeof error === "string" ? error : null,
    checkedAt: setting.updatedAt,
  };
}

/** Records a read of npm's `latest` (now). */
export async function setLatestHarnessVersionCheck(
  db: Database,
  organizationId: string,
  check: { version: string | null; error: string | null },
): Promise<void> {
  await setAppSetting(db, organizationId, LATEST_HARNESS_VERSION_KEY, check, null);
}

/**
 * The tasks chat's "ask about code" (a query task) and "start work" (a coding
 * task) run for the organization, unless a channel overrides them
 * (`chat_channel_task_settings`). Absent: `DEFAULT_CHAT_TASKS`.
 */
export const CHAT_TASKS_KEY = "chat.tasks";

export interface ChatTasks {
  /** The definition ID of the query task "ask about code" runs. */
  askAboutCode: string;
  /** The definition ID of the coding task "start work" runs. */
  startWork: string;
}

/** The built-in tasks chat runs when the organization hasn't chosen any. */
export const DEFAULT_CHAT_TASKS: ChatTasks = {
  askAboutCode: "builtin:ask-about-code",
  startWork: "builtin:handle-request",
};

/** The organization's chat tasks; a field not set (or not a string) is the built-in default. */
export async function getChatTaskDefaults(
  db: Database,
  organizationId: string,
): Promise<ChatTasks> {
  const setting = await getAppSetting(db, organizationId, CHAT_TASKS_KEY);
  const value = (
    typeof setting?.value === "object" && setting.value !== null ? setting.value : {}
  ) as { askAboutCode?: unknown; startWork?: unknown };
  return {
    askAboutCode:
      typeof value.askAboutCode === "string" ? value.askAboutCode : DEFAULT_CHAT_TASKS.askAboutCode,
    startWork: typeof value.startWork === "string" ? value.startWork : DEFAULT_CHAT_TASKS.startWork,
  };
}

/** Sets (or, with null, clears back to the built-in defaults) the organization's chat tasks. */
export async function setChatTaskDefaults(
  db: Database,
  organizationId: string,
  tasks: ChatTasks | null,
  updatedBy: string | null,
): Promise<void> {
  await setAppSetting(db, organizationId, CHAT_TASKS_KEY, tasks, updatedBy);
}
