/** Per-organization settings (`app_settings`): one JSON value per organization and key. */
import { TASK_TYPES, type TaskType } from "@omniralph/tasks";
import { and, eq } from "drizzle-orm";
import { recordChange } from "./changes.js";
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
  db: Pick<Database, "select">,
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
  } else {
    await db
      .insert(appSettings)
      .values({ organizationId, key, value, updatedBy })
      .onConflictDoUpdate({
        target: [appSettings.organizationId, appSettings.key],
        set: { value, updatedBy, updatedAt: new Date() },
      });
  }
  const section = SETTING_SECTIONS[key];
  if (section) {
    recordChange(db, { resource: "settings", section, ids: [organizationId], organizationId });
  }
}

/** The settings section a key's save changes (live `settings` changes); others are internal. */
const SETTING_SECTIONS: Record<string, "agent_defaults" | "connection" | undefined> = {
  "harness.desiredVersion": "agent_defaults",
  "harness.maxConcurrency": "agent_defaults",
  "tasks.allowedTypes": "agent_defaults",
  "chat.tasks": "connection",
};

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

/**
 * The task types the organization's harnesses and repositories allow unless they set their own
 * (a subset of `TASK_TYPES`, in that order). Absent: `DEFAULT_ALLOWED_TASK_TYPES`.
 */
export const ALLOWED_TASK_TYPES_KEY = "tasks.allowedTypes";

/** The task types allowed when the organization hasn't chosen any: all of them. */
export const DEFAULT_ALLOWED_TASK_TYPES: readonly TaskType[] = TASK_TYPES;

function isTaskType(value: unknown): value is TaskType {
  return (TASK_TYPES as readonly unknown[]).includes(value);
}

/** The organization's allowed task types; absent or not a list of task types is the built-in default. */
export async function getAllowedTaskTypeDefaults(
  db: Pick<Database, "select">,
  organizationId: string,
): Promise<TaskType[]> {
  const setting = await getAppSetting(db, organizationId, ALLOWED_TASK_TYPES_KEY);
  const value = setting?.value;
  if (!Array.isArray(value) || !value.every(isTaskType)) return [...DEFAULT_ALLOWED_TASK_TYPES];
  return TASK_TYPES.filter((type) => value.includes(type));
}

/**
 * Sets (or, with null, clears back to the built-in default) the organization's allowed task
 * types. Throws on a type not in `TASK_TYPES`; duplicates are dropped.
 */
export async function setAllowedTaskTypeDefaults(
  db: Database,
  organizationId: string,
  types: readonly string[] | null,
  updatedBy: string | null,
): Promise<void> {
  if (types !== null) {
    const unknown = types.filter((type) => !isTaskType(type));
    if (unknown.length > 0) throw new Error(`Unknown task types: ${unknown.join(", ")}`);
  }
  const value = types === null ? null : TASK_TYPES.filter((type) => types.includes(type));
  await setAppSetting(db, organizationId, ALLOWED_TASK_TYPES_KEY, value, updatedBy);
}

/**
 * How many jobs at once the organization's harnesses run unless they set their own (an integer,
 * `MIN_MAX_CONCURRENCY`–`MAX_MAX_CONCURRENCY`). Absent: `DEFAULT_MAX_CONCURRENCY`.
 */
export const DEFAULT_MAX_CONCURRENCY_KEY = "harness.maxConcurrency";

export const MIN_MAX_CONCURRENCY = 1;
export const MAX_MAX_CONCURRENCY = 32;
/** The harness max concurrency when the organization hasn't chosen one. */
export const DEFAULT_MAX_CONCURRENCY = 5;

function isMaxConcurrency(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= MIN_MAX_CONCURRENCY &&
    (value as number) <= MAX_MAX_CONCURRENCY
  );
}

/** The organization's default harness max concurrency; absent or out of range is the built-in default. */
export async function getDefaultMaxConcurrency(
  db: Database,
  organizationId: string,
): Promise<number> {
  const value = (await getAppSetting(db, organizationId, DEFAULT_MAX_CONCURRENCY_KEY))?.value;
  return isMaxConcurrency(value) ? value : DEFAULT_MAX_CONCURRENCY;
}

/**
 * Sets (or, with null, clears back to the built-in default) the organization's default harness
 * max concurrency. Throws unless it is an integer from 1 to 32.
 */
export async function setDefaultMaxConcurrency(
  db: Database,
  organizationId: string,
  maxConcurrency: number | null,
  updatedBy: string | null,
): Promise<void> {
  if (maxConcurrency !== null && !isMaxConcurrency(maxConcurrency)) {
    throw new Error(
      `Max concurrency must be an integer from ${MIN_MAX_CONCURRENCY} to ${MAX_MAX_CONCURRENCY}`,
    );
  }
  await setAppSetting(db, organizationId, DEFAULT_MAX_CONCURRENCY_KEY, maxConcurrency, updatedBy);
}

/**
 * The organization's tracker labels (`TrackerLabels`), which routing applies before any
 * playbook is chosen. Absent: `DEFAULT_TRACKER_LABELS`.
 */
export const TRACKER_LABELS_KEY = "tracker.labels";

export interface TrackerLabels {
  /** Labels marking a story as a manual step (matched ignoring case); the first labels those Om files. */
  manualLabels: string[];
  /**
   * Labels (matched ignoring case) that keep Om off a work item: a delegation or mention of an
   * issue (or its epic) with one is refused, whichever repo it routes to.
   */
  blockedLabels: string[];
}

/** The tracker labels when the organization hasn't chosen any. */
export const DEFAULT_TRACKER_LABELS: TrackerLabels = {
  manualLabels: ["manual"],
  blockedLabels: ["under-review", "blocked"],
};

function labelList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((label) => typeof label === "string")) return null;
  return value.map((label: string) => label.trim()).filter(Boolean);
}

/**
 * The organization's tracker labels; a list not set (or not a list of strings) is its default,
 * and an empty manual list is the default too (manual stories need a label).
 */
export async function getTrackerLabels(
  db: Pick<Database, "select">,
  organizationId: string,
): Promise<TrackerLabels> {
  const setting = await getAppSetting(db, organizationId, TRACKER_LABELS_KEY);
  const value = (
    typeof setting?.value === "object" && setting.value !== null ? setting.value : {}
  ) as { manualLabels?: unknown; blockedLabels?: unknown };
  const manual = labelList(value.manualLabels);
  return {
    manualLabels: manual?.length ? manual : [...DEFAULT_TRACKER_LABELS.manualLabels],
    blockedLabels: labelList(value.blockedLabels) ?? [...DEFAULT_TRACKER_LABELS.blockedLabels],
  };
}

/** Sets (or, with null, clears back to the defaults) the organization's tracker labels. */
export async function setTrackerLabels(
  db: Database,
  organizationId: string,
  labels: TrackerLabels | null,
  updatedBy: string | null,
): Promise<void> {
  await setAppSetting(db, organizationId, TRACKER_LABELS_KEY, labels, updatedBy);
}
