import { REPO_SYNC_JOB_TYPE, RepoSyncPayload } from "@omniralph/shared";
import type { SystemRpc } from "./index.js";

/**
 * `repo.sync` (targeted at the agent when a repo is pinned to it) clones the
 * repo into the cache, or fetches it if it's already there, and runs nothing else.
 */
export const repoSyncRpc: SystemRpc = {
  name: REPO_SYNC_JOB_TYPE,
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
