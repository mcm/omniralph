import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { leaveOrganization } from "@/lib/organizations/settings";

/** Leaves the active organization (not its last admin) and switches to another of the caller's. */
export const POST = apiHandler({}, async ({ user }) => leaveOrganization(getDb(), user));
