import { GITHUB_API_URL, type GitHubAppAuth } from "./app-auth.js";

export interface GitHubInstallation {
  id: number;
  /** User or organization the app is installed on. */
  account: string;
  accountType: string;
  /** `all` or `selected` repositories. */
  repositorySelection: string;
  /** Where an admin can change the installation's repositories on GitHub. */
  htmlUrl: string;
}

export interface GitHubInstallationRepo {
  id: number;
  fullPath: string;
  private: boolean;
  htmlUrl: string;
}

/** The app installation `installationId`; fails (404) when it isn't an installation of this app. */
export async function getInstallation(
  auth: GitHubAppAuth,
  installationId: number,
): Promise<GitHubInstallation> {
  const octokit = auth.appOctokit(await auth.getAppJwt());
  const { data } = await octokit.apps.getInstallation({ installation_id: installationId });
  const account = data.account as {
    login?: string;
    slug?: string;
    name?: string;
    type?: string;
  } | null;
  return {
    id: data.id,
    account: account?.login ?? account?.slug ?? account?.name ?? String(data.id),
    accountType: account?.type ?? data.target_type,
    repositorySelection: data.repository_selection,
    htmlUrl: data.html_url,
  };
}

/** Every repository the installation can access. */
export async function listInstallationRepos(
  auth: GitHubAppAuth,
  installationId: number,
): Promise<GitHubInstallationRepo[]> {
  const { token } = await auth.getInstallationToken(installationId, {
    permissions: { metadata: "read" },
  });
  const octokit = auth.octokit(token);
  const repos = await octokit.paginate(octokit.apps.listReposAccessibleToInstallation, {
    per_page: 100,
  });
  return repos
    .map((repo) => ({
      id: repo.id,
      fullPath: repo.full_name,
      private: repo.private,
      htmlUrl: repo.html_url,
    }))
    .sort((a, b) => a.fullPath.localeCompare(b.fullPath));
}

/** The app's slug (`GET /app`), used in its public installation URL. */
export async function getAppSlug(auth: GitHubAppAuth): Promise<string> {
  const octokit = auth.appOctokit(await auth.getAppJwt());
  const { data } = await octokit.apps.getAuthenticated();
  if (!data?.slug) throw new Error("GitHub didn't return the app's slug");
  return data.slug;
}

/**
 * Page where a GitHub user installs the app on an account and picks
 * repositories. GitHub then redirects to the app's Setup URL with
 * `installation_id` and `setup_action`.
 */
export function appInstallUrl(slug: string, apiUrl: string = GITHUB_API_URL): string {
  const api = apiUrl.replace(/\/+$/, "");
  if (api === GITHUB_API_URL)
    return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
  // GitHub Enterprise Server: https://<host>/api/v3 → https://<host>/github-apps/<slug>/installations/new
  const origin = new URL(api).origin;
  return `${origin}/github-apps/${encodeURIComponent(slug)}/installations/new`;
}
