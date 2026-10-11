import type { JobPayload, SystemRpcName } from "@omniralph/shared";
import type { JobContext, JobOutput } from "../capabilities/index.js";
import { repoSyncRpc } from "./repo-sync.js";
import { worktreeExecRpc } from "./worktree-exec.js";

/**
 * What a system RPC gets for running one job: its single job token (in
 * `env()`) and the repo cache. No session token and no session environment:
 * system RPCs never start a Claude session.
 */
export type SystemRpcContext = Pick<
  JobContext,
  "signal" | "jobToken" | "env" | "spawn" | "server" | "workspaceRoot" | "repos" | "logger"
>;

/** A fixed command run as a job of task type `system`, dispatched by its name (the job type). */
export interface SystemRpc {
  name: SystemRpcName;
  run(job: JobPayload, ctx: SystemRpcContext): Promise<JobOutput>;
}

/** The harness's system RPCs, keyed by name. */
export class SystemRpcRegistry {
  private readonly byName = new Map<string, SystemRpc>();

  constructor(rpcs: readonly SystemRpc[]) {
    for (const rpc of rpcs) {
      if (this.byName.has(rpc.name)) throw new Error(`system RPC '${rpc.name}' registered twice`);
      this.byName.set(rpc.name, rpc);
    }
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  /** The RPC called `name`, or undefined for an unknown one. */
  get(name: string): SystemRpc | undefined {
    return this.byName.get(name);
  }
}

/** The system RPCs this build of the harness ships. */
export function defaultSystemRpcs(): SystemRpc[] {
  return [repoSyncRpc, worktreeExecRpc];
}
