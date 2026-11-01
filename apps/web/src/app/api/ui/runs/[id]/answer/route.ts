import { getRunIndexEntry } from "@omniralph/db";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { runAnswerRequestSchema, type RunDetail } from "@/lib/api/runs";
import { requireRunAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { RUN_ACTION_ROLES } from "@/lib/runs/actions";
import { loadRunDetail } from "@/lib/runs/detail";
import { answerQuestion } from "@/lib/runs/question";
import { userDisplayName } from "@/lib/user-display";

type Params = { id: string };

const NOT_FOUND = "That run doesn't exist.";

/**
 * Answers a run's open question (members of its organization) with `{questionKey, optionId}`:
 * one of the options of the run detail's (or the Inbox item's) `question`. The answer reaches
 * the run as a reply in its tracker conversation or chat thread would, and the run goes on. Answers
 * the run's detail. 409 "This question was already answered." when the key isn't open anymore,
 * 400 for an option the question doesn't offer.
 */
export const POST = apiHandler<"member", typeof runAnswerRequestSchema, undefined, Params>(
  { access: RUN_ACTION_ROLES.answer, body: runAnswerRequestSchema },
  async ({ user, params, body }): Promise<RunDetail> => {
    const { run, organization } = await requireRunAccess(user, params.id, {
      role: RUN_ACTION_ROLES.answer,
      notFoundMessage: NOT_FOUND,
    });
    const db = getDb();
    await answerQuestion(db, run, body, userDisplayName(user));
    // The index entry carries the run's status: read it again.
    const current = (await getRunIndexEntry(db, run.id)) ?? run;
    const detail = await loadRunDetail(db, current, organization, user.id);
    if (!detail) throw ApiRouteError.notFound(NOT_FOUND);
    return detail;
  },
);
