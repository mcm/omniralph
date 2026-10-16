import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { requestHarnessUpdate } from "@/lib/harnesses/manage";

/** "Update now": the harness updates with its next heartbeat; answers the version requested. */
export const POST = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: "admin" },
  async ({ user, params }) => requestHarnessUpdate(getDb(), user.organization.id, params.id),
);
