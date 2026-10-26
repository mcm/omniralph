import { z } from "zod";

/**
 * Wire format of `GET /api/ui/connections`: every connection of the active organization
 * (GitHub App installations, GitLab connections, the Linear integration, Slack workspaces
 * and Discord servers), as Settings' section nav lists them. No token or secret.
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
});
export type Connection = z.infer<typeof connectionSchema>;

export const connectionListSchema = z.object({ connections: z.array(connectionSchema) });
export type ConnectionList = z.infer<typeof connectionListSchema>;
