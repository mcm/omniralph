import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JOB_TOKEN_FILE_ENV, SERVER_ENV, withoutJobEnv } from "../../job-env.js";
import type { JobContext } from "../index.js";

const REFRESH_MS = 30_000;

export interface GitAccess {
  /** `env` for git: the agent's `git-credential` helper reads the job token from a file. */
  env: NodeJS.ProcessEnv;
  /** Stops refreshing the token file and removes it. */
  close(): Promise<void>;
}

/**
 * Git access for a job's own git commands (fetches, the story's push, the
 * cleanup's pushes): the job's environment with the server URL and
 * `OMNIRALPH_JOB_TOKEN_FILE` naming a private file with the job token instead
 * of `OMNIRALPH_JOB_TOKEN`. The token in the file follows `ctx.jobToken()`
 * (refreshed by heartbeats), so a push at the end of a long story still
 * authenticates, where the token in an environment taken at the start would
 * have expired.
 */
export async function jobGitAccess(
  ctx: Pick<JobContext, "env" | "jobToken" | "server">,
  options: {
    refreshMs?: number;
    /** The token the file follows (default `ctx.jobToken`). */
    token?: () => string;
  } = {},
): Promise<GitAccess> {
  const currentToken = options.token ?? (() => ctx.jobToken());
  const dir = await mkdtemp(path.join(tmpdir(), "omniralph-job-token-"));
  const file = path.join(dir, "token");
  let written = currentToken();
  await writeFile(file, written, { mode: 0o600 });
  let pending: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    const token = currentToken();
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
      ...withoutJobEnv(ctx.env()),
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

/**
 * Git access for a Claude session that fetches and pushes itself (a
 * `ralph.request` session; story sessions leave pushing to the job): like
 * `jobGitAccess`, with only the agent's `git-credential` helper and no
 * askpass or prompts, so pushes late in a long session still authenticate;
 * `OMNIRALPH_JOB_TOKEN` itself stays out of the session. The file holds
 * `ctx.sessionToken()`, never a run-spec job's lifecycle token.
 */
export async function sessionGitAccess(
  ctx: Pick<JobContext, "env" | "jobToken" | "sessionToken" | "server" | "repos">,
  options: { refreshMs?: number } = {},
): Promise<GitAccess> {
  const access = await jobGitAccess(ctx, { ...options, token: () => ctx.sessionToken() });
  return { ...access, env: ctx.repos.gitEnv(access.env) };
}
