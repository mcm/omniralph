import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { loadHarnessChoices, type HarnessChoices } from "@/lib/harnesses/editor-choices";

/** What the agent form picks models and installables from (admins). */
export const GET = apiHandler({ access: "admin" }, async ({ user }): Promise<HarnessChoices> =>
  loadHarnessChoices(getDb(), user.organization.id),
);
