import { z } from "zod";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { revokeApiToken } from "@/lib/auth/api-token-service";
import { getDb } from "@/lib/db";

/** Revokes one of the signed-in member's own API tokens; 404 for any other. Session only. */
export const DELETE = apiHandler<"member", undefined, undefined, { id: string }>(
  {},
  async ({ user, params }) => {
    const id = z.uuid().safeParse(params.id);
    if (!id.success) throw ApiRouteError.notFound();
    return revokeApiToken(getDb(), user, id.data);
  },
);
