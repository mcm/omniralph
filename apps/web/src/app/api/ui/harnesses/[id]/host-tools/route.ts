import { getAgentOverview, listAgentHostTools } from "@omniralph/db";
import { z } from "zod";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { hostToolPathsSaveSchema, type HarnessHostTools } from "@/lib/api/harnesses";
import { getDb } from "@/lib/db";
import { saveHostToolPaths } from "@/lib/harnesses/manage";

type Params = { id: string };

/** Every host tool of the organization's catalog on the harness (Host tools tab). */
export const GET = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }): Promise<HarnessHostTools> => {
    if (!z.uuid().safeParse(params.id).success) throw ApiRouteError.notFound();
    const db = getDb();
    const orgId = user.organization.id;
    const [harness, hostTools] = await Promise.all([
      getAgentOverview(db, orgId, params.id),
      listAgentHostTools(db, orgId, params.id),
    ]);
    if (!harness) throw ApiRouteError.notFound();
    return {
      hostTools: hostTools.map((tool) => ({
        ...tool,
        reportedAt: tool.reportedAt?.toISOString() ?? null,
      })),
    };
  },
);

/** Saves configured paths in one request: the harness gets them with its next heartbeat after `savedAt`. */
export const PUT = apiHandler<"admin", typeof hostToolPathsSaveSchema, undefined, Params>(
  { access: "admin", body: hostToolPathsSaveSchema },
  async ({ user, params, body }) => {
    const result = await saveHostToolPaths(getDb(), user.organization.id, params.id, body);
    return result.ok ? { ...result, savedAt: new Date().toISOString() } : result;
  },
);
