import { getTriageRun } from "@omniralph/db";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { runTriageAnswersRequestSchema, type RunTriageAnswersResult } from "@/lib/api/runs";
import { requireRunAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { RUN_ACTION_ROLES } from "@/lib/runs/actions";
import { ralphDepsOf } from "@/lib/runs/ralph-deps";
import { triageStartError } from "@/lib/runs/retry";
import { answerTriageQuestions } from "@/lib/triage/answers";
import { userDisplayName } from "@/lib/user-display";

type Params = { id: string };

const NOT_FOUND = "That run doesn't exist.";

/**
 * Answers some or all of a triage run's open questions (members of its organization) with
 * `{answers: [{index, question, answer}]}` (`runTriageAnswersRequestSchema`). The answers reach
 * the run as one reply naming the sender, as a reply in its tracker session would: a finished
 * run triages again with them (`retriage`), a queued or running one keeps them for its next job
 * (`pending`). 400 for another kind of run or a triage without open questions, 409 when a
 * question changed since the user read it or another triage of the issue is active.
 */
export const POST = apiHandler<"member", typeof runTriageAnswersRequestSchema, undefined, Params>(
  { access: RUN_ACTION_ROLES.answer, body: runTriageAnswersRequestSchema },
  async ({ user, params, body }): Promise<RunTriageAnswersResult> => {
    const { run: entry } = await requireRunAccess(user, params.id, {
      role: RUN_ACTION_ROLES.answer,
      notFoundMessage: NOT_FOUND,
    });
    if (entry.kind !== "triage") {
      throw new ApiRouteError(400, "Only a triage's open questions can be answered.", "no_triage");
    }
    const db = getDb();
    const run = await getTriageRun(db, entry.id);
    if (!run) throw ApiRouteError.notFound(NOT_FOUND);
    const deps = await ralphDepsOf(db, entry.organizationId);
    const result = await answerTriageQuestions(deps, run, body.answers, userDisplayName(user));
    switch (result.kind) {
      case "no_questions":
        throw new ApiRouteError(
          400,
          "This triage has no open questions to answer.",
          "no_questions",
        );
      case "unknown_question":
        throw new ApiRouteError(400, "That question doesn't exist.", "invalid_request");
      case "questions_changed":
        throw new ApiRouteError(
          409,
          "The open questions changed. Reload them and answer again.",
          "questions_changed",
        );
      case "conflict":
        throw new ApiRouteError(
          409,
          "The work item is being triaged in another run right now. Send the answers again once it's over.",
          "run_busy",
        );
      case "pending":
        return { kind: "pending" };
      case "retriage":
        if (result.outcome.status === "queued") return { kind: "retriage" };
        throw triageStartError(result.outcome, deps.tracker.provider);
      case "ignored":
      case "stop":
      case "not_running":
        // The run went away meanwhile (a non-blank reply is never ignored or a stop).
        throw ApiRouteError.notFound(NOT_FOUND);
    }
  },
);
