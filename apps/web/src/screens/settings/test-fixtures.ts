import { TEST_ORGANIZATION_ID } from "@/components/query-test-utils";
import type { OrganizationSettings } from "@/lib/api/organization";
import type { SettingsHistoryEntry } from "@/lib/api/settings-history";

/** The active organization's latest change: Grace renamed it from "Acme Corp" to "Acme". */
export function organizationChange(
  overrides: Partial<SettingsHistoryEntry> = {},
): SettingsHistoryEntry {
  return {
    id: "change-1",
    organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
    section: "organization",
    subjectId: null,
    actor: { id: "user-2", name: "Grace" },
    changedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    changes: [{ field: "name", label: "Name", before: "Acme Corp", after: "Acme" }],
    runsSince: 3,
    ...overrides,
  };
}

/** `GET /api/ui/organization` for the test user's organization "Acme", as an admin sees it. */
export function organizationSettings(
  overrides: Partial<OrganizationSettings> = {},
): OrganizationSettings {
  return {
    organization: { id: TEST_ORGANIZATION_ID, name: "Acme", allowDomainJoin: false },
    isAdmin: true,
    currentUserId: "user-1",
    domains: [],
    members: [],
    invitations: [],
    history: organizationChange(),
    ...overrides,
  };
}
