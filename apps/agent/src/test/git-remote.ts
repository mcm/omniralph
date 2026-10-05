import { execFileSync } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Git environment isolated from the host's config. */
export const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

export async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** A bare "remote" plus a working clone to push commits from. */
export class Remote {
  readonly bare: string;
  private readonly work: string;

  constructor(readonly root: string) {
    this.bare = path.join(root, "remote.git");
    this.work = path.join(root, "work");
  }

  init(): void {
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", this.bare], {
      env: ENV,
    });
    git(this.bare, "config", "uploadpack.allowFilter", "true");
    git(this.bare, "config", "uploadpack.allowAnySHA1InWant", "true");
    execFileSync("git", ["clone", "--quiet", this.bare, this.work], { env: ENV });
  }

  /** Commits `files` on `branch` and pushes; returns the commit SHA. */
  async commit(files: Record<string, string>, branch = "main"): Promise<string> {
    if (git(this.work, "branch", "--show-current") !== branch) {
      git(this.work, "checkout", "--quiet", "-B", branch);
    }
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(this.work, file)), { recursive: true });
      await writeFile(path.join(this.work, file), content);
    }
    git(this.work, "add", "-A");
    git(this.work, "commit", "--quiet", "-m", `commit ${Object.keys(files).join(",")}`);
    git(this.work, "push", "--quiet", "origin", branch);
    return git(this.work, "rev-parse", "HEAD");
  }

  /**
   * Moves `branch` of the remote to `ref` (e.g. `refs/pull/1/head`), which the
   * default refspec doesn't fetch, and deletes the branch.
   */
  hideBranch(branch: string, ref: string): void {
    git(this.bare, "update-ref", ref, `refs/heads/${branch}`);
    git(this.bare, "update-ref", "-d", `refs/heads/${branch}`);
  }

  /** Rewrites `branch` to a new commit that isn't on any other branch; returns it. */
  async unadvertisedCommit(): Promise<string> {
    const sha = await this.commit({ "pr.txt": "pull request head\n" }, "pr-branch");
    // Only reachable from a ref the default refspec doesn't fetch (like refs/pull/N/head).
    git(this.bare, "update-ref", "refs/pull/1/head", sha);
    git(this.bare, "update-ref", "-d", "refs/heads/pr-branch");
    return sha;
  }
}
