import type { Metadata } from "next";
import { DESIRED_HARNESS_VERSION_KEY, getAppSetting } from "@omniralph/db";
import { HARNESS_PACKAGE } from "@omniralph/shared";
import { organizationHarnessVersion } from "@/lib/harnesses/desired-version";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { HarnessSettingsView } from "./harness-settings-view";

export const metadata: Metadata = { title: "Harness settings · Omniralph" };

export default async function HarnessSettingsPage() {
  const admin = await requirePageUser("admin");
  const db = getDb();
  const [setting, resolved] = await Promise.all([
    getAppSetting(db, admin.organization.id, DESIRED_HARNESS_VERSION_KEY),
    organizationHarnessVersion(db, admin.organization.id),
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
    />
  );
}
