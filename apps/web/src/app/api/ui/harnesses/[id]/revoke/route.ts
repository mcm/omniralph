import { apiHandler } from "@/lib/api/handler";
import { clientIp } from "@/lib/harnesses/request";
import { revokeAgent } from "@/lib/harnesses/manage";

/** Revokes the harness: its tokens stop working, its running jobs are redelivered, its pins removed. */
export const POST = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: "admin" },
  async ({ user, params, request }) =>
    revokeAgent(params.id, {
      organizationId: user.organization.id,
      userId: user.id,
      ip: clientIp(request.headers),
    }),
);
