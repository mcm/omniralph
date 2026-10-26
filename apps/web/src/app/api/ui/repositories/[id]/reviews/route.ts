import { apiHandler } from "@/lib/api/handler";
import { reviewsCardInputSchema, type ReviewsCard } from "@/lib/api/repositories";
import { requireRepositoryAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { saveReviewsCard, type CardSaved } from "@/lib/repositories/cards";
import { settingsActor } from "@/lib/settings-history/sections";

/**
 * Saves the Reviews card (admins of the repo's organization, whichever of theirs is active):
 * exactly `reviewsCardInputSchema`, in one transaction with one change-history entry.
 * Answers `{ ok, card }` with the saved card.
 */
export const PUT = apiHandler<"member", typeof reviewsCardInputSchema, undefined, { id: string }>(
  { body: reviewsCardInputSchema },
  async ({ user, params, body }): Promise<CardSaved<ReviewsCard>> => {
    const { repository } = await requireRepositoryAccess(user, params.id, "admin");
    return saveReviewsCard(getDb(), settingsActor(user), repository, body);
  },
);
