import { apiHandler } from "@/lib/api/handler";
import { harnessSettingsSaveSchema } from "@/lib/api/harnesses";
import { getDb } from "@/lib/db";
import { saveHarnessSettings } from "@/lib/harnesses/manage";

/**
 * Saves the Settings tab's changes in one request (config and desired version):
 * the harness gets them with its next heartbeat after `savedAt`.
 */
export const PUT = apiHandler<"admin", typeof harnessSettingsSaveSchema, undefined, { id: string }>(
  { access: "admin", body: harnessSettingsSaveSchema },
  async ({ user, params, body }) => {
    const result = await saveHarnessSettings(getDb(), user.organization.id, params.id, body);
    return result.ok ? { ...result, savedAt: new Date().toISOString() } : result;
  },
);
