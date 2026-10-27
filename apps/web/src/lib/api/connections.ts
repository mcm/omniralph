import { z } from "zod";
import { connectionHealthSummarySchema } from "./repositories";
import { settingsHistoryEntrySchema } from "./settings-history";

/**
 * Wire format of `GET /api/ui/connections`: every connection of the active organization
 * (GitHub App installations, GitLab connections, the Linear integration, Slack workspaces
 * and Discord servers), as Settings' section nav and connection pages show them, with their
 * health and use. No token or secret.
 */

/** The providers a connection can be of, in the order Settings lists them. */
export const CONNECTION_PROVIDERS = ["github", "gitlab", "linear", "slack", "discord"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

/** Each provider's display name. */
export const CONNECTION_PROVIDER_LABELS: Record<ConnectionProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  linear: "Linear",
  slack: "Slack",
  discord: "Discord",
};

/** What a connection is used as. */
export const CONNECTION_ROLES = ["code_host", "tracker", "chat"] as const;
export type ConnectionRole = (typeof CONNECTION_ROLES)[number];

/** Each provider's role. */
export const CONNECTION_PROVIDER_ROLES: Record<ConnectionProvider, ConnectionRole> = {
  github: "code_host",
  gitlab: "code_host",
  linear: "tracker",
  slack: "chat",
  discord: "chat",
};

export const connectionSchema = z.object({
  provider: z.enum(CONNECTION_PROVIDERS),
  id: z.string(),
  name: z.string(),
  /** The code host's web host (`github.com`, `gitlab.example.com`); null for the others. */
  host: z.string().nullable(),
  /**
   * The account it acts in or as: the GitHub account the app is installed on, the GitLab
   * bot user, the Linear workspace, the Slack workspace or the Discord server.
   */
  account: z.string().nullable(),
  /** The token's health (`connectionHealth`): only GitLab connections are checked. */
  health: connectionHealthSummarySchema,
  /**
   * Repos using it: a code host's connected repos, or the repos with a work item match on
   * the Linear tracker; null for chat.
   */
  reposUsing: z.number().int().nonnegative().nullable(),
  usedAs: z.enum(CONNECTION_ROLES),
  /**
   * Failed deliveries not yet replayed (within the 14-day retention, no replay pointing at
   * them); always 0 for chat, which keeps no delivery log.
   */
  failedDeliveries: z.number().int().nonnegative(),
  /** Chat: the identities linked on the connection's platform; null for the others. */
  linkedAccounts: z.number().int().nonnegative().nullable(),
  /** GitLab: the instance's URL, which its token form shows; null for the others. */
  instanceUrl: z.string().nullable(),
  /** GitHub: the App installation's settings page on GitHub; null for the others. */
  installationUrl: z.string().nullable(),
  /** The connection's latest recorded change (section `connection`); null before any. */
  history: settingsHistoryEntrySchema.nullable(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const connectionListSchema = z.object({ connections: z.array(connectionSchema) });
export type ConnectionList = z.infer<typeof connectionListSchema>;

/**
 * `POST /api/ui/connections/gitlab/{id}/rotate` and `PUT /api/ui/connections/gitlab/{id}`
 * (admins): the connection's health once its token was rotated or replaced and re-checked.
 */
export const gitLabTokenResultSchema = z.object({ health: connectionHealthSummarySchema });
export type GitLabTokenResult = z.infer<typeof gitLabTokenResultSchema>;

/** `PUT /api/ui/connections/gitlab/{id}`: the new bot token. */
export const replaceGitLabTokenSchema = z.object({ token: z.string() });
