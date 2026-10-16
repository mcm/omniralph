import { z } from "zod";
import { decodeId, type AgentDetail } from "@/lib/api/definitions";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { deleteAgent, loadAgentDetail, updateAgent } from "@/lib/definitions/manage";

type Params = { id: string };

/** One agent of the organization (a built-in or one of its rows); unknown IDs, another organization's too, are 404. */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<AgentDetail> => {
    const detail = await loadAgentDetail(getDb(), user, decodeId(params.id));
    if (!detail) throw ApiRouteError.notFound();
    return detail;
  },
);

/** Replaces one of the organization's agents (admins). */
export const PUT = apiHandler<"admin", z.ZodUnknown, undefined, Params>(
  { access: "admin", body: z.unknown() },
  async ({ user, params, body }) => updateAgent(getDb(), user, decodeId(params.id), body),
);

/** Deletes one of the organization's agents (admins). */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) => deleteAgent(getDb(), user, decodeId(params.id)),
);
