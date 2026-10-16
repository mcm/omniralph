import { GITLAB_URL } from "@omniralph/scm";
import { apiHandler } from "@/lib/api/handler";
import type { RepositorySetup } from "@/lib/api/repositories";
import { getGitHubInstallUrl, GITHUB_INSTALL_PATH } from "@/lib/scm/github-app";

/**
 * What the Repositories page's Connect buttons need (admins). It may ask GitHub for the app's
 * slug, so the page loads it once rather than polling it.
 */
export const GET = apiHandler({ access: "admin" }, async (): Promise<RepositorySetup> => ({
  // Installations start at our install route, which adds the signed `state`.
  githubInstallPath: (await getGitHubInstallUrl()) ? GITHUB_INSTALL_PATH : null,
  defaultGitLabUrl: process.env.AUTH_GITLAB_URL?.replace(/\/+$/, "") || GITLAB_URL,
}));
