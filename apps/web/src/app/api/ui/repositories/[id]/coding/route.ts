import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import {
  codingCardInputSchema,
  type CodingCardSaveResult,
  type RepositoryCoding,
} from "@/lib/api/repositories";
import { requireResourceInActiveOrganization } from "@/lib/api/resource";
import { requireRepositoryAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { saveCodingCard } from "@/lib/repositories/cards";
import { loadRepositoryCoding } from "@/lib/repositories/detail";
import { settingsActor } from "@/lib/settings-history/sections";

type Params = { id: string };

const codingQuery = z.object({ next: z.string().max(2000).optional() });

/** The repository's coding policy (admins), with its story playbook's round limits. */
export const GET = apiHandler<"admin", undefined, typeof codingQuery, Params>(
  { access: "admin", query: codingQuery },
  async ({ user, params, query }): Promise<RepositoryCoding> => {
    await requireResourceInActiveOrganization(user, "repository", params.id, {
      pathPrefix: `/repositories/${params.id}`,
      next: query.next,
    });
    return loadRepositoryCoding(user.organization.id, params.id);
  },
);

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
