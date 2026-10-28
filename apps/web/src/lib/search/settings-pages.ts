import { SETTINGS_PATHS } from "@/screens/settings/settings-nav";

/** A Settings page search finds: its title (as the Settings nav names it), section and keywords. */
export interface SettingsPage {
  path: string;
  title: string;
  section: string;
  /** Other words people look for it by (lowercase). */
  keywords: readonly string[];
}

/**
 * Every Settings page with a fixed path, in the Settings nav's order. The Advanced pages are
 * listed whether or not the user shows advanced settings: they open by URL either way.
 */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    path: SETTINGS_PATHS.general,
    title: "General",
    section: "Organization",
    keywords: ["organization", "name", "email domains", "agent defaults", "work item states"],
  },
  {
    path: SETTINGS_PATHS.members,
    title: "Members",
    section: "Organization",
    keywords: ["people", "invite", "invitations", "roles", "admins", "team"],
  },
  {
    path: SETTINGS_PATHS.addConnection,
    title: "Add connection",
    section: "Connections",
    keywords: ["connections", "github", "gitlab", "linear", "slack", "discord", "integrations"],
  },
  {
    path: SETTINGS_PATHS.profile,
    title: "Profile & theme",
    section: "You",
    keywords: ["profile", "theme", "dark mode", "light mode", "appearance", "advanced settings"],
  },
  {
    path: SETTINGS_PATHS.linkedAccounts,
    title: "Linked chat accounts",
    section: "You",
    keywords: ["slack", "discord", "chat", "accounts"],
  },
  {
    path: SETTINGS_PATHS.routing,
    title: "Routing rules",
    section: "Advanced",
    keywords: ["routing", "rules", "repos", "work items"],
  },
  {
    path: SETTINGS_PATHS.playbooks,
    title: "Playbooks",
    section: "Advanced",
    keywords: ["prompts", "tasks", "review", "instructions"],
  },
  {
    path: SETTINGS_PATHS.chat,
    title: "Chat channel overrides",
    section: "Advanced",
    keywords: ["chat", "channels", "slack", "discord", "overrides"],
  },
];

/** The Settings page at `path`, or undefined. */
export function settingsPage(path: string): SettingsPage | undefined {
  return SETTINGS_PAGES.find((page) => page.path === path);
}
