import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { CodingTrackerOptions } from "@/lib/api/repositories";
import { requireRepositoryAccess } from "@/lib/api/scope";
import { getTrackerSettingsOptions } from "@/lib/tracker/settings-options";

/**
 * The teams, projects and labels of the repo's organization's Linear workspace, for the
 * Coding card's match editor (admins of the repo's organization). A repo of any of the
 * user's organizations; no workspace answers `disconnected`, a failed load `unavailable`.
 */
export const GET = apiHandler<"member", undefined, undefined, { id: string }>(
  {},
  async ({ user, params }): Promise<CodingTrackerOptions> => {
    const { repository, organization } = await requireRepositoryAccess(user, params.id, "admin");
    if (repository.disconnectedAt) throw ApiRouteError.notFound();
    try {
      const options = await getTrackerSettingsOptions(organization.id);
      if (!options) return { status: "disconnected" };
      return {
        status: "connected",
        teams: options.teams,
        projects: options.projects,
        labels: options.labels,
      };
    } catch (error) {
      console.error("Loading the Linear options for a work item match failed", error);
      return { status: "unavailable" };
    }
  },
);
