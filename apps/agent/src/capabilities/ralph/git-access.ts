import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JOB_TOKEN_FILE_ENV, SERVER_ENV, withoutJobEnv } from "../../job-env.js";
import type { JobContext } from "../index.js";

const REFRESH_MS = 30_000;

export interface SessionGitAccess {
  /** `env` for the session: git authenticates through the agent's `git-credential` helper. */
  env: NodeJS.ProcessEnv;
  /** Stops refreshing the token file and removes it. */
  close(): Promise<void>;
}

/**
 * Git access for a Claude session that fetches and pushes itself (a
 * `ralph.request` session; story sessions leave pushing to the job): the
 * session's environment gets the agent's `git-credential` helper, no askpass
 * or prompts, the server URL and `OMNIRALPH_JOB_TOKEN_FILE` naming a private
 * file with the job token. The token in the file follows `ctx.jobToken()`
 * (refreshed by heartbeats), so pushes late in a long session still
 * authenticate; `OMNIRALPH_JOB_TOKEN` itself stays out of the session.
 */
export async function sessionGitAccess(
  ctx: Pick<JobContext, "env" | "jobToken" | "server" | "repos">,
  options: { refreshMs?: number } = {},
): Promise<SessionGitAccess> {
  const dir = await mkdtemp(path.join(tmpdir(), "omniralph-job-token-"));
  const file = path.join(dir, "token");
  let written = ctx.jobToken();
  await writeFile(file, written, { mode: 0o600 });
  let pending: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    const token = ctx.jobToken();
    if (token === written) return;
    written = token;
    // Write-then-rename so a helper reading mid-refresh never sees a truncated file.
    pending = pending
      .then(async () => {
        const tmp = `${file}.tmp`;
        await writeFile(tmp, token, { mode: 0o600 });
        await rename(tmp, file);
      })
      .catch(() => {});
  }, options.refreshMs ?? REFRESH_MS);
  timer.unref();
  return {
    env: {
      ...ctx.repos.gitEnv(withoutJobEnv(ctx.env())),
      [SERVER_ENV]: ctx.server,
      [JOB_TOKEN_FILE_ENV]: file,
    },
    async close() {
      clearInterval(timer);
      await pending;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
