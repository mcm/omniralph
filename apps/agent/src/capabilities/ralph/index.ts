import { RALPH_CLEANUP_JOB_TYPE, RALPH_JOB_TYPES, RALPH_PREPARE_JOB_TYPE } from "@omniralph/shared";
import type { Capability } from "../index.js";
import type { StoryOptions } from "../../lifecycle/story-attempt.js";
import { RALPH_CLEANUP_TOOL_POLICY, RALPH_PREPARE_TOOL_POLICY } from "./policy.js";
import { runCleanup } from "./cleanup.js";
import { runPrepare } from "./prepare.js";

export {
  RALPH_CLEANUP_TOOL_POLICY,
  RALPH_PREPARE_TOOL_POLICY,
  RALPH_TOOL_POLICY,
} from "./policy.js";

/** A job type this build registers but can't run yet; failing it is final, not retried. */
export class NotImplementedJobError extends Error {
  override name = "NotImplementedJobError";
}

/**
 * Ralph's remaining legacy jobs, `ralph.prepare` and `ralph.cleanup` (the
 * control panel now runs both as system RPCs). Stories, requests and PR/MR
 * descriptions run as coding and query tasks (`lifecycle/`).
 */
export function createRalphCapability(options: StoryOptions = {}): Capability {
  return {
    name: "ralph",
    jobTypes: RALPH_JOB_TYPES,
    toolPolicy: RALPH_PREPARE_TOOL_POLICY,
    jobToolPolicies: {
      [RALPH_PREPARE_JOB_TYPE]: RALPH_PREPARE_TOOL_POLICY,
      [RALPH_CLEANUP_JOB_TYPE]: RALPH_CLEANUP_TOOL_POLICY,
    },
    run(job, ctx) {
      if (job.type === RALPH_PREPARE_JOB_TYPE) return runPrepare(job, ctx, options);
      if (job.type === RALPH_CLEANUP_JOB_TYPE) return runCleanup(job, ctx);
      return Promise.reject(
        new NotImplementedJobError(`${job.type} jobs are not supported by this agent yet`),
      );
    },
  };
}

export const ralphCapability: Capability = createRalphCapability();
