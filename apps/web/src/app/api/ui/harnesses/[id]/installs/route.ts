import { apiHandler } from "@/lib/api/handler";
import { installRequestSchema } from "@/lib/api/harnesses";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { installInstallable } from "@/lib/harnesses/manage";

/** Starts an install job of an installable on the harness; answers its id. */
export const POST = apiHandler<"admin", typeof installRequestSchema, undefined, { id: string }>(
  { access: "admin", body: installRequestSchema },
  async ({ user, params, body }) =>
    installInstallable(getDb(), getDispatcher(), user.organization.id, params.id, body),
);
