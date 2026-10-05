import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { git } from "../git.js";
import type { EvalCase } from "./case.js";

/** Temp repo directories are `<prefix><case id>-XXXXXX`. */
export const CASE_REPO_PREFIX = "omniralph-eval-";

/** The case ID of a `buildCaseRepo` directory (path or basename), or undefined. */
export function caseIdFromRepoDir(dir: string): string | undefined {
  const name = basename(dir);
  const match = /^(.+)-[^-]{6}$/.exec(name.slice(CASE_REPO_PREFIX.length));
  return name.startsWith(CASE_REPO_PREFIX) && match ? match[1] : undefined;
}

export interface CaseRepo {
  /** Temp git repo; its working tree is checked out at `headSha`. */
  dir: string;
  baseSha: string;
  headSha: string;
  /** Removes the temp repo. */
  cleanup(): Promise<void>;
}

/**
 * Fixed identity and dates and no user/system config, so a case always
 * produces the same SHAs and git hooks or signing never run.
 */
function caseGitEnv(date: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Omniralph Eval",
    GIT_AUTHOR_EMAIL: "eval@omniralph.invalid",
    GIT_COMMITTER_NAME: "Omniralph Eval",
    GIT_COMMITTER_EMAIL: "eval@omniralph.invalid",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

/**
 * Creates a temp git repo for a case: `base/` committed on `main`, then
 * `change.patch` applied and committed on top as the head.
 */
export async function buildCaseRepo(
  evalCase: Pick<EvalCase, "id" | "dir">,
  options: { tmpRoot?: string } = {},
): Promise<CaseRepo> {
  const dir = await mkdtemp(
    join(options.tmpRoot ?? tmpdir(), `${CASE_REPO_PREFIX}${evalCase.id}-`),
  );
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const baseEnv = caseGitEnv("2026-01-01T00:00:00Z");
    const headEnv = caseGitEnv("2026-01-01T00:01:00Z");
    await cp(join(evalCase.dir, "base"), dir, { recursive: true });
    await git(dir, ["init", "-q", "-b", "main"], baseEnv);
    await git(dir, ["add", "-A"], baseEnv);
    await git(dir, ["commit", "-q", "--no-verify", "-m", "base"], baseEnv);
    const baseSha = (await git(dir, ["rev-parse", "HEAD"], baseEnv)).trim();
    await git(dir, ["checkout", "-q", "-b", "change"], headEnv);
    await git(
      dir,
      ["apply", "--index", "--whitespace=nowarn", join(evalCase.dir, "change.patch")],
      headEnv,
    );
    await git(dir, ["commit", "-q", "--no-verify", "-m", `change: ${evalCase.id}`], headEnv);
    const headSha = (await git(dir, ["rev-parse", "HEAD"], headEnv)).trim();
    return { dir, baseSha, headSha, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
