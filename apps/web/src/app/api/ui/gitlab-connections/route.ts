import { apiHandler } from "@/lib/api/handler";
import { connectGitLabSchema } from "@/lib/api/repositories";
import { getDb } from "@/lib/db";
import { connectGitLab } from "@/lib/repositories/manage";

/** Connects GitLab with a bot token (validated first); answers the connection to pick projects of. */
export const POST = apiHandler(
  { access: "admin", body: connectGitLabSchema },
  async ({ user, body }) => connectGitLab(getDb(), user, body),
);
