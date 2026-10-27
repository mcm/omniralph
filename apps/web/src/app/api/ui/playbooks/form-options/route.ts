import type { PlaybookFormOptions } from "@/lib/api/playbooks";
import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { loadPlaybookFormOptions } from "@/lib/playbooks/manage";

/** What the playbook editor offers: roles, reported models, tool names and MCP servers (admins). */
export const GET = apiHandler({ access: "admin" }, async ({ user }): Promise<PlaybookFormOptions> =>
  loadPlaybookFormOptions(getDb(), user),
);
