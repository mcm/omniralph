import { apiHandler } from "@/lib/api/handler";
import { codingCardInputSchema, type CodingCardSaveResult } from "@/lib/api/repositories";
import { requireRepositoryAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { saveCodingCard } from "@/lib/repositories/cards";
import { settingsActor } from "@/lib/settings-history/sections";

type Params = { id: string };

/**
 * Saves the Coding card (admins of the repo's organization, whichever of theirs is active):
 * exactly `codingCardInputSchema` – the switch, work item match and policy – in one
 * transaction with one change-history entry. Answers `{ ok, card, warnings }` with the saved
 * card and the other repos whose matches conflict with its match.
 */
export const PUT = apiHandler<"member", typeof codingCardInputSchema, undefined, Params>(
  { body: codingCardInputSchema },
  async ({ user, params, body }): Promise<CodingCardSaveResult> => {
    const { repository } = await requireRepositoryAccess(user, params.id, "admin");
    return saveCodingCard(getDb(), settingsActor(user), repository, body);
  },
);
