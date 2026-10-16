import { apiHandler } from "@/lib/api/handler";
import type { CodingLinear } from "@/lib/api/repositories";
import { requireResourceInActiveOrganization } from "@/lib/api/resource";
import { loadCodingLinear } from "@/lib/repositories/detail";

/**
 * The organization's Linear workspace (teams, labels, projects, states) the repository's
 * Coding tab picks from, or why it can't. Calls Linear: the page loads it once, not polled.
 */
export const GET = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: "admin" },
  async ({ user, params }): Promise<CodingLinear> => {
    await requireResourceInActiveOrganization(user, "repository", params.id, {
      pathPrefix: `/repositories/${params.id}`,
    });
    return loadCodingLinear(user.organization.id);
  },
);
