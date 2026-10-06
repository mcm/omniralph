import {
  RALPH_CAPABILITY,
  RALPH_DESCRIBE_PR_JOB_TYPE,
  RALPH_JOB_TYPES,
  RALPH_PREPARE_JOB_TYPE,
  RALPH_REQUEST_JOB_TYPE,
  RALPH_STORY_JOB_TYPE,
} from "@omniralph/shared";
import type { Capability } from "../index.js";
import {
  RALPH_DESCRIBE_PR_TOOL_POLICY,
  RALPH_PREPARE_TOOL_POLICY,
  RALPH_TOOL_POLICY,
} from "./policy.js";
import { runDescribePr } from "./describe-pr.js";
import { runPrepare } from "./prepare.js";
import { runRequest } from "./request.js";
import { runStory, type StoryOptions } from "./story.js";

export {
  RALPH_DESCRIBE_PR_TOOL_POLICY,
  RALPH_PREPARE_TOOL_POLICY,
  RALPH_TOOL_POLICY,
} from "./policy.js";

/** A job type this build registers but can't run yet; failing it is final, not retried. */
export class NotImplementedJobError extends Error {
  override name = "NotImplementedJobError";
}

/**
 * Builds a delegated Linear epic story by story (ported from cyralph). The
 * control panel orchestrates the run; this capability runs its jobs:
 * `ralph.story`, `ralph.describe-pr`, `ralph.prepare` and `ralph.request`.
 */
export function createRalphCapability(options: StoryOptions = {}): Capability {
  return {
    name: RALPH_CAPABILITY,
    jobTypes: RALPH_JOB_TYPES,
    toolPolicy: RALPH_TOOL_POLICY,
    jobToolPolicies: {
      [RALPH_STORY_JOB_TYPE]: RALPH_TOOL_POLICY,
      [RALPH_DESCRIBE_PR_JOB_TYPE]: RALPH_DESCRIBE_PR_TOOL_POLICY,
      [RALPH_PREPARE_JOB_TYPE]: RALPH_PREPARE_TOOL_POLICY,
      [RALPH_REQUEST_JOB_TYPE]: RALPH_TOOL_POLICY,
    },
    run(job, ctx) {
      if (job.type === RALPH_STORY_JOB_TYPE) return runStory(job, ctx, options);
      if (job.type === RALPH_DESCRIBE_PR_JOB_TYPE) return runDescribePr(job, ctx, options);
      if (job.type === RALPH_PREPARE_JOB_TYPE) return runPrepare(job, ctx, options);
      if (job.type === RALPH_REQUEST_JOB_TYPE) return runRequest(job, ctx, options);
      return Promise.reject(
        new NotImplementedJobError(`${job.type} jobs are not supported by this agent yet`),
      );
    },
  };
}

export const ralphCapability: Capability = createRalphCapability();
