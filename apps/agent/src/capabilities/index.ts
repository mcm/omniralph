import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { JobPayload } from "@omniralph/shared";
import type { Logger } from "../logger.js";
import type { RepoCache } from "../workspace/repoCache.js";
import { ralphCapability } from "./ralph/index.js";
import { reviewCapability } from "./review.js";
import { systemCapability } from "./system.js";

/**
 * What a capability's Claude sessions may do. The agent builds the SDK's
 * permission options from it (`sdkPermissions` in `tool-policy.ts`). Review
 * is read-only: `Read`/`Grep`/`Glob` inside the job's worktree, nothing else.
 * Ralph edits and runs commands in its branch worktree.
 */
export interface ToolPolicy {
  /** The session's tools: exactly `allowedTools`, or Claude Code's whole default set. */
  tools: "allowed" | "claude_code";
  /** Tools a session may use without asking. */
  allowedTools: readonly string[];
  /** Tools that are always denied, even if a setting would allow them. */
  disallowedTools: readonly string[];
  /**
   * `worktree`: file tools are denied outside the job's worktree (by a
   * PreToolUse hook). `cwd`: the session runs in the worktree but nothing is
   * enforced (write-capable sessions with a shell can't be confined).
   */
  fileScope: "worktree" | "cwd";
  /** `bypassPermissions` only for write-capable policies. */
  permissionMode: "default" | "dontAsk" | "bypassPermissions";
  /**
   * Which `.claude/` settings (and with them skills, MCP config, `CLAUDE.md`)
   * sessions load. Empty: none, and no skills, plugins or MCP servers at all.
   */
  settingSources: readonly ("user" | "project" | "local")[];
  /** Whether sessions may change the worktree (edit files, run commands). */
  writable: boolean;
  /**
   * Read-only shell commands (e.g. `git log`) a session without a shell may
   * run anyway: Bash is available, but only for these commands with plain
   * arguments (no pipes, redirections, substitutions or output files).
   */
  readOnlyCommands?: readonly string[];
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
  /**
   * The repo cache under `workspaceRoot`. Pass `env()` to its calls, so git
   * runs the `git-credential` helper with this job's token.
   */
  repos: RepoCache;
  logger: Logger;
  /**
   * Registers the job's live Claude session for messages from the control
   * panel (`jobMessages`, e.g. Linear replies to a ralph run), or unregisters
   * it (`undefined`) once the session takes no more input. Messages arriving
   * while none is registered are rejected, and the control panel applies them
   * another way.
   */
  setMessageInjector?(inject: ((text: string) => boolean) | undefined): void;
}

/** The capability's output, sent to `/api/agent/jobs/{id}/result`. */
export type JobOutput = Record<string, unknown>;

export interface Capability {
  name: string;
  /** Job types (`jobs.type`) this capability runs, e.g. `review.run`. */
  jobTypes: readonly string[];
  toolPolicy: ToolPolicy;
  /** Job types whose sessions run with a different policy than `toolPolicy`. */
  jobToolPolicies?: Readonly<Record<string, ToolPolicy>>;
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

/** The tool policy of `jobType`'s sessions. */
export function toolPolicyFor(capability: Capability, jobType: string): ToolPolicy {
  return capability.jobToolPolicies?.[jobType] ?? capability.toolPolicy;
}

/** The capabilities this build of the agent ships; `system` is built in and always enabled. */
export function defaultCapabilities(): Capability[] {
  return [systemCapability, reviewCapability, ralphCapability];
}
