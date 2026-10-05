import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Large diffs are planned and trimmed after parsing, so allow big outputs here. */
const MAX_BUFFER = 512 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Runs git in `cwd`. `env` replaces `process.env` (e.g. to configure the
 * credential helper that lazy blob fetches of a partial clone need).
 */
export async function git(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    const { stdout } = await exec("git", [...args], {
      cwd,
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  } catch (error) {
    const e = error as { code?: unknown; stderr?: string; message: string };
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    throw new GitError(
      `git ${args[0] ?? ""} failed: ${stderr || e.message}`,
      typeof e.code === "number" ? e.code : undefined,
      stderr,
    );
  }
}

/** Whether `ancestor` is a commit in `head`'s history (false if either is unknown). */
export async function isAncestor(
  cwd: string,
  ancestor: string,
  head: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", ancestor, head], env);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode !== undefined) return false;
    throw error;
  }
}

/**
 * Unified diff in a fixed format whatever the user's git config says
 * (prefixes, renames, external diff tools, colors).
 * `from...to` (three dots) diffs against the merge base; `from..to` diffs the two commits.
 */
export function diff(cwd: string, range: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return git(
    cwd,
    [
      "-c",
      "core.quotePath=true",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      range,
      "--",
    ],
    env,
  );
}

/** A file's content at a commit, or undefined if it doesn't exist there (or isn't a file). */
export async function showFile(
  cwd: string,
  commit: string,
  path: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const type = (await git(cwd, ["cat-file", "-t", `${commit}:${path}`], env)).trim();
    if (type !== "blob") return undefined;
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
  return git(cwd, ["cat-file", "blob", `${commit}:${path}`], env);
}
