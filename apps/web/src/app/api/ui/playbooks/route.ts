import { z } from "zod";
import type { PlaybookList } from "@/lib/api/playbooks";
import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { createPlaybook, loadPlaybookList } from "@/lib/playbooks/manage";

/** The organization's playbooks, built-ins first, with role, model and what uses each. Every member may look. */
export const GET = apiHandler({}, async ({ user }): Promise<PlaybookList> =>
  loadPlaybookList(getDb(), user),
);

/** Creates one of the organization's playbooks (admins); answers its ID. */
export const POST = apiHandler({ access: "admin", body: z.unknown() }, async ({ user, body }) =>
  createPlaybook(getDb(), user, body),
);
