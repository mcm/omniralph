import { GITLAB_URL } from "@omniralph/scm";
import { apiHandler } from "@/lib/api/handler";
import { repositorySetupQuerySchema, type RepositorySetup } from "@/lib/api/repositories";
import { requireOrganizationAccess } from "@/lib/api/scope";
import { getGitHubInstallUrl, githubInstallPath } from "@/lib/scm/github-app";

/**
 * What the Connect buttons need for `organization` (the active one when left out), where the
 * user must be an admin. It may ask GitHub for the app's slug, so the sheet loads it once
 * rather than polling it.
 */
export const GET = apiHandler(
  { query: repositorySetupQuerySchema },
  async ({ user, query }): Promise<RepositorySetup> => {
    const organization = await requireOrganizationAccess(
      user,
      query.organization ?? user.organization.id,
      { role: "admin" },
    );
    return {
      // Installations start at our install route, which adds the signed `state`.
      githubInstallPath: (await getGitHubInstallUrl()) ? githubInstallPath(organization.id) : null,
      defaultGitLabUrl: process.env.AUTH_GITLAB_URL?.replace(/\/+$/, "") || GITLAB_URL,
    };
  },
);
