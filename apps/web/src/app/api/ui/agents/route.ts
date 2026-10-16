import { z } from "zod";
import type { AgentList } from "@/lib/api/definitions";
import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { createAgent, loadAgentList } from "@/lib/definitions/manage";

/** Settings › Agents: the organization's agents, built-ins first. Every member may look. */
export const GET = apiHandler({}, async ({ user }): Promise<AgentList> =>
  loadAgentList(getDb(), user),
);

/** Creates one of the organization's agents (admins); answers its ID. */
export const POST = apiHandler({ access: "admin", body: z.unknown() }, async ({ user, body }) =>
  createAgent(getDb(), user, body),
);
