import { spawn } from "node:child_process";

/** A git command that exited non-zero (or couldn't start). */
export class GitError extends Error {
  override name = "GitError";
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `git ${args.join(" ")} failed${exitCode === null ? "" : ` (exit ${exitCode})`}: ${stderr.trim().slice(-2000)}`,
    );
  }
}

/** Quotes a word for `sh` (git runs `!`-helpers through the shell). */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `credential.helper` value that runs this agent's `git-credential`
 * command: the same Node binary, flags (e.g. tsx's loader in development) and
 * CLI script as the running process.
 */
export function defaultCredentialHelper(
  execPath = process.execPath,
  execArgv: readonly string[] = process.execArgv,
  script = process.argv[1],
): string {
  if (!script)
    throw new Error("can't determine the agent's CLI script for the git credential helper");
  return `!${[execPath, ...execArgv, script, "git-credential"].map(shellQuote).join(" ")}`;
}

/**
 * Leading `-c` options for every job git command: `credential.helper=` resets
 * the helper list (dropping system, global and URL-specific helpers of the
 * host), then only the agent's helper is configured. `core.askPass=` keeps
 * git from prompting through an askpass program.
 */
export function credentialConfigArgs(credentialHelper: string): string[] {
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${credentialHelper}`,
    "-c",
    "core.askPass=",
  ];
}

/**
 * The same configuration as {@link credentialConfigArgs}, as environment
 * variables (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, which
 * git treats like `-c`), for git commands the agent doesn't spawn itself
 * (e.g. the engine's diffs, which fetch missing blobs of a partial clone).
 */
export function credentialConfigEnv(credentialHelper: string): NodeJS.ProcessEnv {
  const entries: [string, string][] = [
    ["credential.helper", ""],
    ["credential.helper", credentialHelper],
    ["core.askPass", ""],
  ];
  return {
    GIT_CONFIG_COUNT: String(entries.length),
    ...Object.fromEntries(
      entries.flatMap(([key, value], i) => [
        [`GIT_CONFIG_KEY_${i}`, key],
        [`GIT_CONFIG_VALUE_${i}`, value],
      ]),
    ),
  };
}

export interface RunGitOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  git?: string;
}

/**
 * The environment git runs with: never prompt, and no host askpass program
 * (e.g. Coder's `GIT_ASKPASS`), which would otherwise answer for missing
 * credentials (it takes precedence over `core.askPass`).
 */
export function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { GIT_ASKPASS: _git, SSH_ASKPASS: _ssh, ...rest } = env;
  return { ...rest, GIT_TERMINAL_PROMPT: "0" };
}

/** Runs git and resolves with its stdout; rejects with `GitError`, or the signal's reason on abort. */
export function runGit(args: readonly string[], options: RunGitOptions): Promise<string> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const child = spawn(options.git ?? "git", args, {
      cwd: options.cwd,
      // Never prompt: a missing credential must fail the command, not hang it.
      env: gitEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new GitError(args, null, error.message));
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new GitError(args, code, Buffer.concat(stderr).toString("utf8")));
    });
  });
}
