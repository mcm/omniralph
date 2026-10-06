import type { Metadata } from "next";
import {
  listRepositoryOverviewPage,
  listScmConnections,
  REPOSITORY_PAGE_SIZE,
} from "@omniralph/db";
import { GITLAB_URL } from "@omniralph/scm";
import { hasRole } from "@/lib/auth/roles";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { parsePage } from "@/lib/pagination";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { getGitHubInstallUrl } from "@/lib/scm/github-app";
import { RepositoriesView, type GitHubNotice } from "./repositories-view";

export const metadata: Metadata = { title: "Repositories · Omniralph" };

const NOTICES: Record<string, GitHubNotice> = {
  requested: "requested",
  invalid: "invalid",
  error: "error",
};

export default async function RepositoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ github?: string; page?: string | string[] }>;
}) {
  const user = await requirePageUser();
  const isAdmin = hasRole(user, "admin");
  const db = getDb();
  const { github, page } = await searchParams;
  const [repos, githubConnections, githubInstallUrl] = await Promise.all([
    listRepositoryOverviewPage(db, { page: parsePage(page), pageSize: REPOSITORY_PAGE_SIZE }),
    isAdmin ? listScmConnections(db, "github") : [],
    isAdmin ? getGitHubInstallUrl() : null,
  ]);

  return (
    <RepositoriesView
      page={repos.page}
      pageSize={repos.pageSize}
      total={repos.total}
      repositories={repos.repositories.map((repo) => ({
        id: repo.id,
        provider: repo.provider,
        fullPath: repo.fullPath,
        webUrl: repositoryWebUrl(repo.provider, repo.baseUrl, repo.fullPath),
        enabled: repo.enabled,
        profileName: repo.profileName,
        pinnedAgents: repo.pinnedAgents,
        lastReviewAt: repo.lastReviewAt?.toISOString() ?? null,
      }))}
      githubInstallations={githubConnections.map((c) => ({ id: c.id, name: c.name }))}
      githubInstallUrl={githubInstallUrl}
      defaultGitLabUrl={process.env.AUTH_GITLAB_URL?.replace(/\/+$/, "") || GITLAB_URL}
      githubNotice={github ? (NOTICES[github] ?? null) : null}
    />
  );
}
