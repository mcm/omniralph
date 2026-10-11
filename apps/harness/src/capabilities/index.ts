import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { JobPayload, RunSpec } from "@omniralph/shared";
import type { Logger } from "../logger.js";
import type { RepoCache } from "../workspace/repoCache.js";
import { ralphCapability } from "./ralph/index.js";
import { reviewCapability } from "./review.js";
import { systemCapability } from "./system.js";
import { triageCapability } from "./triage/index.js";

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
  /**
   * A run-spec job's run (agent, task, trigger, repository, tools, model,
   * budget and tokens), resolved by the control panel at claim time. Its
   * `tokens` are as claimed: use `jobToken()`/`sessionToken()` for current ones.
   * Unset for legacy jobs.
   */
  runSpec?: RunSpec;
  /**
   * The job's current token (refreshed by heartbeats): a run-spec job's
   * `lifecycle` token, kept for the harness's own calls (e.g. fetching
   * credentials), or a legacy job's single token.
   */
  jobToken(): string;
  /**
   * The token the job's Claude session gets: a run-spec job's `session`
   * token (never `credentials:write`); a legacy job's single token.
   */
  sessionToken(): string;
  /**
   * Environment for the harness's own subprocesses (e.g. git fetches): `jobToken()`
   * in `OMNIRALPH_JOB_TOKEN`, never the harness's tokens.
   */
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /**
   * Environment for the Claude session and the processes it runs (incl. its
   * git credential helper): `sessionToken()` in `OMNIRALPH_JOB_TOKEN`, never the
   * lifecycle token. A session's `OMNIRALPH_JOB_TOKEN_FILE` must hold `sessionToken()` too.
   */
  sessionEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
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

/** The capability's output, sent to `/api/harness/jobs/{id}/result`. */
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

/**
 * The harness's legacy job code, grouped by the capability that ships it.
 * Jobs are dispatched by their type alone; each type belongs to one capability.
 */
export class CapabilityRegistry {
  private readonly byName = new Map<string, Capability>();
  private readonly byJobType = new Map<string, Capability>();

  constructor(capabilities: readonly Capability[]) {
    for (const capability of capabilities) {
      if (this.byName.has(capability.name)) {
        throw new Error(`capability '${capability.name}' registered twice`);
      }
      this.byName.set(capability.name, capability);
      for (const type of capability.jobTypes) {
        if (this.byJobType.has(type)) throw new Error(`job type '${type}' registered twice`);
        this.byJobType.set(type, capability);
      }
    }
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  get(name: string): Capability | undefined {
    return this.byName.get(name);
  }

  /** The capability that runs `job`, or undefined for an unknown job type. */
  forJob(job: Pick<JobPayload, "type">): Capability | undefined {
    return this.byJobType.get(job.type);
  }
}

/** The tool policy of `jobType`'s sessions. */
export function toolPolicyFor(capability: Capability, jobType: string): ToolPolicy {
  return capability.jobToolPolicies?.[jobType] ?? capability.toolPolicy;
}

/** The capabilities this build of the agent ships; `system` is built in and always enabled. */
export function defaultCapabilities(): Capability[] {
  return [systemCapability, reviewCapability, ralphCapability, triageCapability];
}
