import {
  listRepositoryOverviewPage,
  listScmConnections,
  REPOSITORY_PAGE_SIZE,
} from "@omniralph/db";
import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import type { RepositoryList } from "@/lib/api/repositories";
import { hasRole } from "@/lib/auth/roles";
import { getDb } from "@/lib/db";
import { parsePage } from "@/lib/pagination";
import { repositoryWebUrl } from "@/lib/repositories/web-url";

const listQuery = z.object({ page: z.string().optional() });

/**
 * A page of the active organization's connected repositories, and (admins only) its code-host
 * connections with their health: the Repositories page.
 */
export const GET = apiHandler(
  { query: listQuery },
  async ({ user, query }): Promise<RepositoryList> => {
    const db = getDb();
    const organizationId = user.organization.id;
    const [repos, connections] = await Promise.all([
      listRepositoryOverviewPage(db, organizationId, {
        page: parsePage(query.page),
        pageSize: REPOSITORY_PAGE_SIZE,
      }),
      hasRole(user, "admin") ? listScmConnections(db, organizationId) : [],
    ]);
    return {
      page: repos.page,
      pageSize: repos.pageSize,
      total: repos.total,
      repositories: repos.repositories.map((repo) => ({
        id: repo.id,
        provider: repo.provider,
        fullPath: repo.fullPath,
        webUrl: repositoryWebUrl(repo.provider, repo.baseUrl, repo.fullPath),
        taskTypes: {
          query: { on: repo.queryEnabled, inherited: repo.overrides.query === null },
          review: { on: repo.enabled, inherited: repo.overrides.review === null },
          coding: { on: repo.ralphEnabled, inherited: repo.overrides.coding === null },
        },
        depth: repo.reviewDepth,
        pinnedHarnesses: repo.pinnedHarnesses,
        lastReviewAt: repo.lastReviewAt?.toISOString() ?? null,
      })),
      connections: connections.map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        health: connection.health,
      })),
    };
  },
);
