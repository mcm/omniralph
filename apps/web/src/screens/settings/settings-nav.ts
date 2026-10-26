import type { SectionNavGroup, SectionNavItem } from "@omniralph/ui";
import {
  CONNECTION_PROVIDER_LABELS,
  type Connection,
  type ConnectionProvider,
} from "@/lib/api/connections";

/** Settings' section list (narrow), or General beside the nav (wide). */
export const SETTINGS_PATH = "/settings";

/** Every Settings page's path (Technical Considerations, "Routes"). */
export const SETTINGS_PATHS = {
  general: "/settings/general",
  members: "/settings/members",
  addConnection: "/settings/connections/new",
  profile: "/settings/profile",
  linkedAccounts: "/settings/linked-accounts",
  routing: "/settings/advanced/routing",
  playbooks: "/settings/advanced/playbooks",
  chat: "/settings/advanced/chat",
} as const;

/** A connection's page: `/settings/connections/{provider}/{id}`. */
export function connectionHref(connection: Pick<Connection, "provider" | "id">): string {
  return `/settings/connections/${connection.provider}/${encodeURIComponent(connection.id)}`;
}

/**
 * Each connection's entry label: its provider ("GitLab"), plus its name when the
 * organization has more than one of that provider ("GitLab · ann @ gitlab.example.com").
 */
export function connectionLabels(connections: readonly Connection[]): Map<string, string> {
  const counts = new Map<ConnectionProvider, number>();
  for (const connection of connections) {
    counts.set(connection.provider, (counts.get(connection.provider) ?? 0) + 1);
  }
  return new Map(
    connections.map((connection) => {
      const provider = CONNECTION_PROVIDER_LABELS[connection.provider];
      const shared = (counts.get(connection.provider) ?? 0) > 1;
      return [connection.id, shared ? `${provider} · ${connection.name}` : provider];
    }),
  );
}

/**
 * The Settings section nav (Design board Settings): Organization, Connections (one entry
 * per connection, then "Add connection"), You and, only when the user shows advanced
 * settings, Advanced. The Advanced pages open by URL either way.
 */
export function settingsNavGroups({
  connections,
  showAdvanced,
}: {
  connections: readonly Connection[];
  showAdvanced: boolean;
}): SectionNavGroup[] {
  const labels = connectionLabels(connections);
  const connectionItems: SectionNavItem[] = connections.map((connection) => ({
    label: labels.get(connection.id)!,
    href: connectionHref(connection),
  }));
  return [
    {
      label: "Organization",
      items: [
        { label: "General", href: SETTINGS_PATHS.general },
        { label: "Members", href: SETTINGS_PATHS.members },
      ],
    },
    {
      label: "Connections",
      items: [...connectionItems, { label: "Add connection", href: SETTINGS_PATHS.addConnection }],
    },
    {
      label: "You",
      items: [
        { label: "Profile & theme", href: SETTINGS_PATHS.profile },
        { label: "Linked chat accounts", href: SETTINGS_PATHS.linkedAccounts },
      ],
    },
    {
      label: "Advanced",
      items: showAdvanced
        ? [
            { label: "Routing rules", href: SETTINGS_PATHS.routing },
            { label: "Playbooks", href: SETTINGS_PATHS.playbooks },
            { label: "Chat channel overrides", href: SETTINGS_PATHS.chat },
          ]
        : [],
    },
  ];
}
