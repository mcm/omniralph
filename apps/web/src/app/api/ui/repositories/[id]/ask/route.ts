import { apiHandler } from "@/lib/api/handler";
import { askCardInputSchema, type AskCard } from "@/lib/api/repositories";
import { requireRepositoryAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { saveAskCard, type CardSaved } from "@/lib/repositories/cards";
import { settingsActor } from "@/lib/settings-history/sections";

/**
 * Saves the Ask card (admins of the repo's organization): `{ askEnabled }`, with one
 * change-history entry. Answers `{ ok, card }` with the saved card.
 */
export const PUT = apiHandler<"member", typeof askCardInputSchema, undefined, { id: string }>(
  { body: askCardInputSchema },
  async ({ user, params, body }): Promise<CardSaved<AskCard>> => {
    const { repository } = await requireRepositoryAccess(user, params.id, "admin");
    return saveAskCard(getDb(), settingsActor(user), repository, body);
  },
);
