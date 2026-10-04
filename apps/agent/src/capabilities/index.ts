import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { JobPayload } from "@omniralph/shared";
import type { Logger } from "../logger.js";
import { reviewCapability } from "./review.js";

/**
 * What a capability's sessions may do. The review capability is read-only:
 * `Read`/`Grep`/`Glob` inside the job's worktree, nothing else.
 */
export interface ToolPolicy {
  /** Claude Code tools a session may use. */
  allowedTools: readonly string[];
  /** Tools that are always denied, even if a setting would allow them. */
  disallowedTools: readonly string[];
  /** File tools are confined to the job's git worktree. */
  fileScope: "worktree";
  /** Never `bypassPermissions`. */
  permissionMode: "default" | "dontAsk";
  /** Whether sessions may load `.claude/` settings, skills, MCP config or `CLAUDE.md` from the checkout. */
  loadProjectSettings: false;
}

/** What a capability gets for running one job. */
export interface JobContext {
  /** Aborted when the job is canceled centrally (`cancelJobIds`) or the agent shuts down. */
  signal: AbortSignal;
  /** The job's current token (refreshed by heartbeats); only for in-job processes. */
  jobToken(): string;
  /** Environment for subprocesses: the job token in `OMNIRALPH_JOB_TOKEN`, never the agent's tokens. */
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Spawns a subprocess with `env()`. */
  spawn(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
  server: string;
  workspaceRoot: string;
  logger: Logger;
}

/** The capability's output, sent to `/api/agent/jobs/{id}/result`. */
export type JobOutput = Record<string, unknown>;

export interface Capability {
  name: string;
  /** Job types (`jobs.type`) this capability runs, e.g. `review.run`. */
  jobTypes: readonly string[];
  toolPolicy: ToolPolicy;
  run(job: JobPayload, ctx: JobContext): Promise<JobOutput>;
}

/**
 * A transient failure (e.g. a Claude rate limit): the job is redelivered
 * after `retryAfterSeconds` (the control panel's default when omitted).
 * Any other error fails the job.
 */
export class RetryableJobError extends Error {
  override name = "RetryableJobError";
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export class CapabilityRegistry {
  private readonly byName = new Map<string, Capability>();

  constructor(capabilities: readonly Capability[]) {
    for (const capability of capabilities) {
      if (this.byName.has(capability.name)) {
        throw new Error(`capability '${capability.name}' registered twice`);
      }
      this.byName.set(capability.name, capability);
    }
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  get(name: string): Capability | undefined {
    return this.byName.get(name);
  }

  /** The capability that runs `job`, or undefined for an unknown capability or job type. */
  forJob(job: Pick<JobPayload, "capability" | "type">): Capability | undefined {
    const capability = this.byName.get(job.capability);
    return capability?.jobTypes.includes(job.type) ? capability : undefined;
  }
}

/** The capabilities this build of the agent ships. */
export function defaultCapabilities(): Capability[] {
  return [reviewCapability];
}
