import { apiHandler } from "@/lib/api/handler";
import { harnessDefaultsSaveSchema, type AgentDefaults } from "@/lib/api/harness-defaults";
import { getDb } from "@/lib/db";
import { loadHarnessDefaults, saveHarnessDefaults } from "@/lib/harnesses/defaults";

/** Settings › Harness defaults (admins): the desired version and the task-type and concurrency defaults. */
export const GET = apiHandler({ access: "admin" }, async ({ user }): Promise<AgentDefaults> =>
  loadHarnessDefaults(getDb(), user.organization.id),
);

/**
 * Saves the Defaults tab's changes in one request (defaults, then the version): harnesses get
 * them with their next claim or heartbeat.
 */
export const PUT = apiHandler(
  { access: "admin", body: harnessDefaultsSaveSchema },
  async ({ user, body }) => saveHarnessDefaults(getDb(), user, body),
);
