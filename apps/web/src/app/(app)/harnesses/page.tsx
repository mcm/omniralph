import type { Metadata } from "next";
import { listHarnessOverview } from "@omniralph/db";
import { organizationHarnessVersion } from "@/lib/harnesses/desired-version";
import { harnessRow } from "@/lib/harnesses/rows";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { HarnessesView } from "./harnesses-view";

export const metadata: Metadata = { title: "Harnesses · Omniralph" };

export default async function HarnessesPage() {
  const user = await requirePageUser();
  const now = new Date();
  const db = getDb();
  const [harnesses, organizationVersion] = await Promise.all([
    listHarnessOverview(db, user.organization.id),
    organizationHarnessVersion(db, user.organization.id),
  ]);
  return (
    <HarnessesView
      harnesses={harnesses.map((harness) =>
        harnessRow(harness, now, organizationVersion.version, organizationVersion.tracksLatest),
      )}
      now={now.getTime()}
    />
  );
}
