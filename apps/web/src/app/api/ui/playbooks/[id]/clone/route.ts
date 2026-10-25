import { decodeId } from "@/lib/api/playbooks";
import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { clonePlaybook } from "@/lib/playbooks/manage";

type Params = { id: string };

/** Copies a playbook (a built-in or one of the organization's) into a new one (admins); answers its ID. */
export const POST = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) => clonePlaybook(getDb(), user, decodeId(params.id)),
);
