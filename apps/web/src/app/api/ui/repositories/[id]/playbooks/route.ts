import type { ActionResult } from "@/lib/action-result";
import { apiHandler } from "@/lib/api/handler";
import { playbooksCardInputSchema, type PlaybooksCard } from "@/lib/api/repositories";
import { requireRepositoryAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { savePlaybooksCard, type CardSaved } from "@/lib/repositories/cards";
import { settingsActor } from "@/lib/settings-history/sections";

/**
 * Saves the Playbooks card (admins of the repo's organization): `{ bindings }`, every
 * binding. A playbook whose role doesn't suit its binding answers 400. Nobody's "Show
 * advanced settings" preference matters. Answers `{ ok, card }` with the saved card.
 */
export const PUT = apiHandler<"member", typeof playbooksCardInputSchema, undefined, { id: string }>(
  { body: playbooksCardInputSchema },
  async ({ user, params, body }): Promise<CardSaved<PlaybooksCard> | ActionResult> => {
    const { repository } = await requireRepositoryAccess(user, params.id, "admin");
    return savePlaybooksCard(getDb(), settingsActor(user), repository, body);
  },
);
