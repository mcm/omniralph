import { fieldErrors } from "@omniralph/shared";
import { apiHandler, ApiRouteError, INVALID_JSON_MESSAGE } from "@/lib/api/handler";
import { runRetryRequestSchema, type RunDetail } from "@/lib/api/runs";
import { requireRunAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { RUN_ACTION_ROLES } from "@/lib/runs/actions";
import { retryRun } from "@/lib/runs/retry";
import { userDisplayName } from "@/lib/user-display";

type Params = { id: string };

/**
 * Retries an epic or request run (members of its organization), with an optional body
 * `{target}` (`runRetryRequestSchema`): the run (default), one of an epic's stories (a
 * finished epic re-runs a completed one), or an attempt. Answers the run's detail. 400 when
 * the target can't be retried (its PR/MR merged or closed…), 409 while Om works on the run.
 */
export const POST = apiHandler<"member", undefined, undefined, Params>(
  { access: RUN_ACTION_ROLES.retry },
  async ({ user, params, request }): Promise<RunDetail> => {
    const { run, organization } = await requireRunAccess(user, params.id, {
      role: RUN_ACTION_ROLES.retry,
      notFoundMessage: "That run doesn't exist.",
    });
    const { target } = await retryBody(request);
    return retryRun(getDb(), run, organization, target, userDisplayName(user));
  },
);

/** The body: empty, or JSON matching `runRetryRequestSchema`. */
async function retryBody(request: Request) {
  const text = await request.text();
  let json: unknown = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiRouteError(400, INVALID_JSON_MESSAGE, "invalid_json");
    }
  }
  const parsed = runRetryRequestSchema.safeParse(json);
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error);
    throw new ApiRouteError(
      400,
      Object.values(errors)[0] ?? "The request is invalid.",
      "invalid_request",
      errors,
    );
  }
  return parsed.data;
}
