import { apiHandler } from "@/lib/api/handler";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { settingsHistoryQuerySchema, type SettingsHistory } from "@/lib/api/settings-history";
import { getDb } from "@/lib/db";
import { loadSettingsHistory } from "@/lib/settings-history/history";

/**
 * A tracked settings section's change history (every member): who changed what and when,
 * newest first, each entry with the runs started since, and `latest` for the section's info
 * button. `subject` is the repository or connection of a section that has one. Covers the
 * active organization by default, one of the user's (`organization=<id>`) or all of them.
 */
export const GET = apiHandler(
  { query: settingsHistoryQuerySchema },
  async ({ user, query }): Promise<SettingsHistory> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    return loadSettingsHistory(getDb(), organizations, query);
  },
);
