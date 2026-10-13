import type { Metadata } from "next";
import {
  DEFAULT_ALLOWED_TASK_TYPES,
  DEFAULT_MAX_CONCURRENCY,
  DESIRED_HARNESS_VERSION_KEY,
  getAllowedTaskTypeDefaults,
  getAppSetting,
  getDefaultMaxConcurrency,
  listHostTools,
} from "@omniralph/db";
import { HARNESS_PACKAGE } from "@omniralph/shared";
import { organizationHarnessVersion } from "@/lib/harnesses/desired-version";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { HarnessSettingsView } from "./harness-settings-view";

export const metadata: Metadata = { title: "Harness defaults · Omniralph" };

export default async function HarnessSettingsPage() {
  const admin = await requirePageUser("admin");
  const db = getDb();
  const [setting, resolved, hostTools, allowedTaskTypes, maxConcurrency] = await Promise.all([
    getAppSetting(db, admin.organization.id, DESIRED_HARNESS_VERSION_KEY),
    organizationHarnessVersion(db, admin.organization.id),
    listHostTools(db, admin.organization.id),
    getAllowedTaskTypeDefaults(db, admin.organization.id),
    getDefaultMaxConcurrency(db, admin.organization.id),
  ]);
  return (
    <HarnessSettingsView
      desiredVersion={typeof setting?.value === "string" ? setting.value : null}
      updatedAt={setting?.updatedAt.toISOString() ?? null}
      latest={
        resolved.tracksLatest
          ? {
              version: resolved.version,
              error: resolved.latestError,
              checkedAt: resolved.latestCheckedAt?.toISOString() ?? null,
            }
          : null
      }
      packageName={HARNESS_PACKAGE}
      defaults={{ allowedTaskTypes, maxConcurrency }}
      builtInDefaults={{
        allowedTaskTypes: [...DEFAULT_ALLOWED_TASK_TYPES],
        maxConcurrency: DEFAULT_MAX_CONCURRENCY,
      }}
      hostTools={hostTools.map(({ id, name, description }) => ({ id, name, description }))}
    />
  );
}
