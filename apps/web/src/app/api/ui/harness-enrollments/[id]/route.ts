import { z } from "zod";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { enrollmentStatus } from "@/lib/harnesses/enrollment";

/** An enrollment and the harness that redeemed its token, once one has: polled by the enroll dialog. */
export const GET = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: "admin" },
  async ({ user, params }) => {
    const status = z.uuid().safeParse(params.id).success
      ? await enrollmentStatus(getDb(), user.organization.id, params.id)
      : null;
    if (!status) throw ApiRouteError.notFound();
    return status;
  },
);
