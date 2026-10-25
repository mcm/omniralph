import "server-only";
import {
  countRunsSince,
  listSettingsChanges,
  type Database,
  type SettingsChange,
} from "@omniralph/db";
import {
  encodeSettingsHistoryCursor,
  type SettingsHistory,
  type SettingsHistoryEntry,
  type SettingsHistoryQuery,
} from "@/lib/api/settings-history";
import type { ScopedOrganization } from "@/lib/api/scope";
import { runsSinceScope } from "./sections";

/**
 * A settings section's change history for `GET /api/ui/settings-history`: a page of entries,
 * newest first, each with the runs started since it (`runsSinceScope`), plus the newest entry
 * of all for the info button ("last changed by … when …, N runs since").
 */
export async function loadSettingsHistory(
  db: Database,
  organizations: readonly ScopedOrganization[],
  query: Pick<SettingsHistoryQuery, "section" | "subject" | "cursor" | "limit">,
): Promise<SettingsHistory> {
  const subjectId = query.subject ?? null;
  const filter = {
    organizationIds: organizations.map((o) => o.id),
    section: query.section,
    subjectId,
  };
  const [page, newest] = await Promise.all([
    listSettingsChanges(db, { ...filter, cursor: query.cursor ?? null, limit: query.limit }),
    // The first page's first entry is the newest; a later page reads it on its own.
    query.cursor ? listSettingsChanges(db, { ...filter, limit: 1 }) : null,
  ]);
  const byId = new Map(organizations.map((o) => [o.id, o]));
  const scope = runsSinceScope(query.section, subjectId);
  const entry = async (change: SettingsChange): Promise<SettingsHistoryEntry> => {
    const organization = byId.get(change.organizationId)!;
    return {
      id: change.id,
      organization: { id: organization.id, name: organization.name, role: organization.role },
      section: query.section,
      subjectId: change.subjectId,
      actor: { id: change.actor.userId, name: change.actor.name },
      changedAt: change.changedAt.toISOString(),
      changes: change.changes,
      runsSince: await countRunsSince(db, change.organizationId, change.changedAt, scope),
    };
  };
  const entries = await Promise.all(page.entries.map(entry));
  const latestChange = newest ? newest.entries[0] : page.entries[0];
  return {
    latest: newest ? (latestChange ? await entry(latestChange) : null) : (entries[0] ?? null),
    entries,
    next: page.next ? encodeSettingsHistoryCursor(page.next) : null,
  };
}
