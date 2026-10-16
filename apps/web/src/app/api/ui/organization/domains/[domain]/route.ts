import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { removeDomain } from "@/lib/organizations/settings";

type Params = { domain: string };

/** Removes an email domain from the active organization (the last one turns off joining by domain). */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) => removeDomain(getDb(), user, params.domain),
);
