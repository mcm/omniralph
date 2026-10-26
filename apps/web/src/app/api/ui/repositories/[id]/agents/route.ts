import type { ActionResult } from "@/lib/action-result";
import { apiHandler } from "@/lib/api/handler";
import { agentsCardInputSchema, type AgentsCard } from "@/lib/api/repositories";
import { requireRepositoryAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { saveAgentsCard, type CardSaved } from "@/lib/repositories/cards";
import { settingsActor } from "@/lib/settings-history/sections";

/**
 * Saves the Agents card (admins of the repo's organization): `{ pinnedAgentIds }`, every
 * pinned agent. A revoked, deleted or other organization's agent answers 400; newly pinned
 * agents get a `repo.sync` job. Answers `{ ok, card }` with the saved card.
 */
export const PUT = apiHandler<"member", typeof agentsCardInputSchema, undefined, { id: string }>(
  { body: agentsCardInputSchema },
  async ({ user, params, body }): Promise<CardSaved<AgentsCard> | ActionResult> => {
    const { repository } = await requireRepositoryAccess(user, params.id, "admin");
    return saveAgentsCard(getDb(), getDispatcher(), settingsActor(user), repository, body);
  },
);
