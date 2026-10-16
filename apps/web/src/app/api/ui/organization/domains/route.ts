import { apiHandler } from "@/lib/api/handler";
import { domainInputSchema } from "@/lib/api/organization";
import { getDb } from "@/lib/db";
import { addDomain } from "@/lib/organizations/settings";

/** Adds an email domain to the active organization. */
export const POST = apiHandler(
  { access: "admin", body: domainInputSchema },
  async ({ user, body }) => addDomain(getDb(), user, body.domain),
);
