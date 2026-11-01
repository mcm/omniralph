import "server-only";
import { getRun, type Database } from "@omniralph/db";
import type { ActionResult } from "@/lib/action-result";
import { getDispatcher } from "@/lib/dispatch";
import { getTrackerGatewayOrDisconnected } from "@/lib/tracker/client";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { stopRun } from "./reply";

/**
 * Stops a ralph run of `organizationId` the way the tracker's stop reply does (the logic behind
 * `POST /api/ui/runs/{id}/stop`): the run becomes `stopped`, its queued job is canceled and a
 * running one is asked to cancel (it stops after its agent's next heartbeat), and the agent
 * session is told who stopped it. Tracker writes are best-effort, so this works while the
 * organization has no workspace connected. Guidance in the tracker resumes the run.
 */
export async function stopRalphRun(
  db: Database,
  organizationId: string,
  runId: string,
  stoppedBy: string | undefined,
): Promise<ActionResult> {
  const run = await getRun(db, runId);
  if (!run || run.organizationId !== organizationId) {
    return { ok: false, error: "That run doesn't exist." };
  }
  const result = await stopRun(
    {
      db,
      organizationId,
      tracker: await getTrackerGatewayOrDisconnected({ db, organizationId }),
      dispatcher: getDispatcher(),
      adapterFor: scmAdapterFor,
    },
    run,
    stoppedBy,
  );
  switch (result.status) {
    case "gone":
      return { ok: false, error: "That run doesn't exist." };
    case "already":
      return {
        ok: false,
        error:
          result.runStatus === "stopped"
            ? "This run is already stopped."
            : `This run is already over (${result.runStatus}).`,
      };
    case "stopped":
      return { ok: true };
  }
}
