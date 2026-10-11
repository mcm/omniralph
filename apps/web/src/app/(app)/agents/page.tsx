import type { Metadata } from "next";
import { listHarnessOverview } from "@omniralph/db";
import { organizationHarnessVersion } from "@/lib/harnesses/desired-version";
import { harnessRow } from "@/lib/harnesses/rows";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { AgentsView } from "./agents-view";

export const metadata: Metadata = { title: "Agents · Omniralph" };

export default async function AgentsPage() {
  const user = await requirePageUser();
  const now = new Date();
  const db = getDb();
  const [agents, organizationVersion] = await Promise.all([
    listHarnessOverview(db, user.organization.id),
    organizationHarnessVersion(db, user.organization.id),
  ]);
  return (
    <AgentsView
      agents={agents.map((agent) =>
        harnessRow(agent, now, organizationVersion.version, organizationVersion.tracksLatest),
      )}
      now={now.getTime()}
    />
  );
}
