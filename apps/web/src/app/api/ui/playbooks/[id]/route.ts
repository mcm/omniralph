import { z } from "zod";
import { decodeId, type PlaybookDetail } from "@/lib/api/playbooks";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { deletePlaybook, loadPlaybookDetail, updatePlaybook } from "@/lib/playbooks/manage";

type Params = { id: string };

/** One playbook of the organization (a built-in or one of its rows); unknown IDs, another organization's too, are 404. */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<PlaybookDetail> => {
    const detail = await loadPlaybookDetail(getDb(), user, decodeId(params.id));
    if (!detail) throw ApiRouteError.notFound();
    return detail;
  },
);

/** Replaces one of the organization's playbooks (admins), answering its detail and list row; a built-in is refused (409). */
export const PUT = apiHandler<"admin", z.ZodUnknown, undefined, Params>(
  { access: "admin", body: z.unknown() },
  async ({ user, params, body }) => updatePlaybook(getDb(), user, decodeId(params.id), body),
);

/** Deletes one of the organization's playbooks (admins); a built-in or one in use is refused (409). */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) => deletePlaybook(getDb(), user, decodeId(params.id)),
);
