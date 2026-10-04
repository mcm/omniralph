import { REPO_SYNC_JOB_TYPE, RepoSyncPayload, SYSTEM_CAPABILITY } from "@omniralph/shared";
import type { Capability, ToolPolicy } from "./index.js";

/** System jobs run no Claude session at all. */
export const SYSTEM_TOOL_POLICY: ToolPolicy = {
  allowedTools: [],
  disallowedTools: [],
  fileScope: "worktree",
  permissionMode: "dontAsk",
  loadProjectSettings: false,
};

/**
 * Built-in housekeeping, always enabled. `repo.sync` (enqueued on the agent's
 * own topic when a repo is pinned to it) clones the repo into the cache, or
 * fetches it if it's already there, and runs nothing else.
 */
export const systemCapability: Capability = {
  name: SYSTEM_CAPABILITY,
  jobTypes: [REPO_SYNC_JOB_TYPE],
  toolPolicy: SYSTEM_TOOL_POLICY,
  async run(job, ctx) {
    const payload = RepoSyncPayload.safeParse(job.payload);
    if (!payload.success) throw new Error("invalid repo.sync payload");
    const { repository } = payload.data;
    const result = await ctx.repos.sync(repository, { env: ctx.env(), signal: ctx.signal });
    ctx.logger.info(
      { repo: `${repository.provider}/${repository.fullPath}`, cloned: result.cloned },
      "repository synced",
    );
    return {
      repository: `${repository.provider}/${repository.fullPath}`,
      cloned: result.cloned,
      fetched: result.fetched,
    };
  },
};
