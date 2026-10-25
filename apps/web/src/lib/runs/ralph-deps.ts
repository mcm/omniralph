import "server-only";
import type { Database } from "@omniralph/db";
import { getDispatcher } from "@/lib/dispatch";
import { getLinearGatewayOrDisconnected } from "@/lib/linear/client";
import type { RalphDeps } from "@/lib/ralph/run";
import { scmAdapterFor } from "@/lib/scm/adapters";

/** What acting on an epic or request run of the organization needs. */
export async function ralphDepsOf(db: Database, organizationId: string): Promise<RalphDeps> {
  return {
    db,
    organizationId,
    linear: await getLinearGatewayOrDisconnected({ db, organizationId }),
    dispatcher: getDispatcher(),
    adapterFor: scmAdapterFor,
  };
}
