import { apiHandler } from "@/lib/api/handler";
import { recordRecentBodySchema } from "@/lib/api/search";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { recordRecent } from "@/lib/search/search";

/**
 * Records that the user opened a search result (`{ kind, id }`), the newest of their recent
 * items. A run, work item, repo or agent outside their organizations, or an unknown Settings
 * page, answers 404.
 */
export const POST = apiHandler({ body: recordRecentBodySchema }, async ({ user, body }) => {
  await recordRecent({ db: getDb() }, user, body, () => resolveOrganizationScope(user, "all"));
  return { ok: true as const };
});
