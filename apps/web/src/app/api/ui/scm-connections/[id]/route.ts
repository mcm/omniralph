import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { removeScmConnection } from "@/lib/repositories/manage";

type Params = { id: string };

/** Removes the connection with its repositories (and their reviews, rules and pins). */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) =>
    removeScmConnection(getDb(), user, user.organization.id, requireUuid(params.id)),
);
