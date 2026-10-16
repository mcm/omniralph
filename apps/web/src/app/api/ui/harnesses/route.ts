import { listHarnessOverview } from "@omniralph/db";
import { apiHandler } from "@/lib/api/handler";
import type { HarnessList } from "@/lib/api/harnesses";
import { getDb } from "@/lib/db";
import { organizationHarnessVersion } from "@/lib/harnesses/desired-version";
import { harnessRow } from "@/lib/harnesses/rows";

/** npm's `latest` is read at most every 5 minutes (cached); never let it hold up a poll for long. */
const NPM_TIMEOUT_MS = 2_000;

/** The active organization's harnesses: the Harnesses page. */
export const GET = apiHandler({}, async ({ user }): Promise<HarnessList> => {
  const db = getDb();
  const now = new Date();
  const [harnesses, version] = await Promise.all([
    listHarnessOverview(db, user.organization.id),
    organizationHarnessVersion(db, user.organization.id, { timeoutMs: NPM_TIMEOUT_MS }),
  ]);
  return {
    harnesses: harnesses.map((harness) =>
      harnessRow(harness, now, version.version, version.tracksLatest),
    ),
  };
});
