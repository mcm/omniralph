import { TRIAGE_JOB_TYPES, TRIAGE_RUN_JOB_TYPE } from "@omniralph/shared";
import type { Capability } from "../index.js";
import { TRIAGE_TOOL_POLICY } from "./policy.js";
import { runTriage, type TriageOptions } from "./run.js";

export { TRIAGE_TOOL_POLICY } from "./policy.js";

/**
 * Triages a Linear issue into a PRD ralph can build, unattended. The control
 * panel loads the issue and applies the result to Linear (agents hold no
 * Linear token); this capability runs its one read-only session (`triage.run`).
 */
export function createTriageCapability(options: TriageOptions = {}): Capability {
  return {
    name: "triage",
    jobTypes: TRIAGE_JOB_TYPES,
    toolPolicy: TRIAGE_TOOL_POLICY,
    run(job, ctx) {
      if (job.type === TRIAGE_RUN_JOB_TYPE) return runTriage(job, ctx, options);
      return Promise.reject(new Error(`${job.type} jobs are not supported by triage`));
    },
  };
}

export const triageCapability: Capability = createTriageCapability();
