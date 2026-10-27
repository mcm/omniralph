import type { GitHubAccountType } from "@omniralph/db";

/**
 * The kind of account GitHub reports an installation on (`account.type`), as
 * `scm_connections.account_type` records it; null for anything else (e.g. an enterprise).
 */
export function githubAccountType(type: unknown): GitHubAccountType | null {
  return type === "User" || type === "Organization" ? type : null;
}

/**
 * The installation's settings page on GitHub, as the API's `html_url` names it:
 * `/organizations/{login}/settings/installations/{id}` on an organization, else
 * `/settings/installations/{id}`. An installation whose account type isn't recorded yet
 * gets the personal account's page, where it was before the type was recorded.
 */
export function githubInstallationUrl(installation: {
  /** Web host, e.g. `github.com`. */
  host: string;
  /** The account's login (the connection's name). */
  account: string;
  accountType: GitHubAccountType | null;
  installationId: string;
}): string {
  const id = encodeURIComponent(installation.installationId);
  return installation.accountType === "Organization"
    ? `https://${installation.host}/organizations/${encodeURIComponent(installation.account)}/settings/installations/${id}`
    : `https://${installation.host}/settings/installations/${id}`;
}
