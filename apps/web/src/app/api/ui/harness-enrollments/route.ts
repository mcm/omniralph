import { apiHandler } from "@/lib/api/handler";
import { createEnrollmentSchema } from "@/lib/api/harnesses";
import { getDb } from "@/lib/db";
import { createEnrollment, serverUrl } from "@/lib/harnesses/enrollment";

/** Creates a one-time enrollment token (valid for 1 hour) for a new harness of the active organization. */
export const POST = apiHandler(
  { access: "admin", body: createEnrollmentSchema },
  async ({ user, body, request }) =>
    createEnrollment(getDb(), {
      organizationId: user.organization.id,
      createdBy: user.id,
      name: body.name,
      serverUrl: serverUrl(request.headers),
    }),
);
