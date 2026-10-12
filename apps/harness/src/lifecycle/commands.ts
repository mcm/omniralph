import { spawn } from "node:child_process";
import { TRUNCATION_MARKER, type SetupCommand, type TeardownCommand } from "@omniralph/tasks";
import type { Logger } from "../logger.js";

/** Most characters of stderr kept for a failure note or error. */
const MAX_FAILURE_DETAIL = 500;
/** Grace between SIGTERM and SIGKILL when a command times out or the run is aborted. */
const KILL_GRACE_MS = 5_000;

export interface CommandOptions {
  /** The working directory (the checkout, or the run's empty directory). */
  cwd: string;
  /** The command environment: the harness's, without either job token (`withoutJobEnv`). */
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /**
   * Absolute path by command name (the run's host tools and installable
   * commands, see `resolveRunExecutables`): a command whose first word names
   * one runs that path instead (`resolveCommand`).
   */
  executables?: ReadonlyMap<string, string>;
  /**
   * Extra environment by command name (an installable command's cache
   * directories), added after `OMNIRALPH_*` is stripped for a command whose
   * first word names one.
   */
  executableEnv?: ReadonlyMap<string, Readonly<Record<string, string>>>;
}

/** What one command did. */
export interface CommandOutcome {
  /** Exit code; null when it was killed or couldn't start. */
  exitCode: number | null;
  /** Stdout, cut to the cap. */
  stdout: string;
  /** Whether stdout was longer than the cap. */
  truncated: boolean;
  /** The tail of stderr. */
  stderr: string;
  timedOut: boolean;
  /** Why the command couldn't start (e.g. a missing working directory). */
  spawnError?: string;
}

/** A required setup command failed, so the run fails. */
export class SetupCommandError extends Error {
  constructor(
    readonly commandName: string,
    readonly detail: string,
  ) {
    super(`setup command ${commandName} failed: ${detail}`);
    this.name = "SetupCommandError";
  }
}

/**
 * A setup or teardown command's environment: `env` without any `OMNIRALPH_*`
 * variable (either job token) or `GIT_CONFIG_*` override (how git commands
 * get the job's credential helper).
 */
export function commandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !name.startsWith("OMNIRALPH_") &&
        name !== "GIT_CONFIG_COUNT" &&
        !name.startsWith("GIT_CONFIG_KEY_") &&
        !name.startsWith("GIT_CONFIG_VALUE_"),
    ),
  );
}

/** `value` quoted for `sh`. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A command's first word: up to whitespace or a shell operator. */
const FIRST_WORD = /^(\s*)([^\s;&|<>()]+)/;

/**
 * `command` with its first word replaced by that executable's absolute path
 * (quoted) when it names one of `commands`; otherwise unchanged.
 */
export function resolveCommand(
  command: string,
  commands: ReadonlyMap<string, string> = new Map(),
): string {
  const match = FIRST_WORD.exec(command);
  const resolved = match ? commands.get(match[2]!) : undefined;
  if (!match || resolved === undefined) return command;
  return `${match[1]}${shellQuote(resolved)}${command.slice(match[0].length)}`;
}

/**
 * A setup or teardown command's environment: `commandEnv(options.env)` plus
 * the extra environment of the executable its first word names, if any.
 */
function commandEnvFor(command: string, options: CommandOptions): NodeJS.ProcessEnv {
  const name = FIRST_WORD.exec(command)?.[2];
  const extra = name === undefined ? undefined : options.executableEnv?.get(name);
  return { ...commandEnv(options.env), ...extra };
}

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/**
 * Runs `command` with `sh -c` in its own process group, keeping at most
 * `maxStdoutBytes` bytes of stdout (the rest is drained, not buffered) and
 * the tail of stderr. After `timeoutMs`, or when `signal` aborts, the whole
 * group gets SIGTERM, then SIGKILL. Never rejects.
 */
export function runCommand(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxStdoutBytes: number;
    signal?: AbortSignal;
  },
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn("sh", ["-c", command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = options.maxStdoutBytes - stdoutBytes;
      if (chunk.length > room) {
        stdoutChunks.push(chunk.subarray(0, room));
        stdoutBytes += room;
        truncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_FAILURE_DETAIL * 4);
    });

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        // Already gone.
      }
    };
    const stop = () => {
      killGroup("SIGTERM");
      killTimer ??= setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();

    const finish = (outcome: Pick<CommandOutcome, "exitCode"> & { spawnError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      let stdout = Buffer.concat(stdoutChunks).toString("utf8");
      // A cut in the middle of a multi-byte character decodes to U+FFFD.
      if (truncated) stdout = stdout.replace(/\uFFFD$/, "");
      resolve({
        exitCode: outcome.exitCode,
        stdout,
        truncated,
        stderr: tail(stderr, MAX_FAILURE_DETAIL),
        timedOut,
        ...(outcome.spawnError !== undefined && { spawnError: outcome.spawnError }),
      });
    };
    child.on("error", (error) => finish({ exitCode: null, spawnError: error.message }));
    child.on("close", (code) => {
      // The command may leave background processes behind in its group; don't let them outlive it.
      killGroup("SIGKILL");
      finish({ exitCode: code });
    });
  });
}

/** Why a command failed, in one line (e.g. its exit code); null when it succeeded. */
export function failureReason(outcome: CommandOutcome, timeoutMs: number): string | null {
  if (outcome.spawnError !== undefined) return `it couldn't start (${outcome.spawnError})`;
  if (outcome.timedOut) {
    return `it timed out after ${timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`}`;
  }
  if (outcome.exitCode === 0) return null;
  if (outcome.exitCode === null) return "it was killed";
  return `it exited with code ${outcome.exitCode}`;
}

/** `failureReason` plus the stderr tail; null when it succeeded. */
export function failureDetail(outcome: CommandOutcome, timeoutMs: number): string | null {
  const reason = failureReason(outcome, timeoutMs);
  if (reason === null) return null;
  return outcome.stderr ? `${reason}: ${outcome.stderr}` : reason;
}

/**
 * Runs a task's setup commands in order and returns the `setup` variables:
 * each command's stdout by name, cut to its `maxOutputBytes` and marked when
 * cut. A failing command throws `SetupCommandError` (the run fails), unless
 * it's `optional`: then its variable holds a short failure note and the next
 * command runs. An aborted run throws the abort reason.
 */
export async function runSetupCommands(
  commands: readonly SetupCommand[],
  options: CommandOptions & { signal: AbortSignal },
): Promise<Record<string, string>> {
  const setup: Record<string, string> = {};
  for (const command of commands) {
    options.signal.throwIfAborted();
    const started = Date.now();
    const timeoutMs = command.timeoutSeconds * 1000;
    const outcome = await runCommand(resolveCommand(command.command, options.executables), {
      cwd: options.cwd,
      env: commandEnvFor(command.command, options),
      timeoutMs,
      maxStdoutBytes: command.maxOutputBytes,
      signal: options.signal,
    });
    options.signal.throwIfAborted();
    const log = {
      name: command.name,
      exitCode: outcome.exitCode,
      durationMs: Date.now() - started,
    };
    const reason = failureReason(outcome, timeoutMs);
    if (reason === null) {
      options.logger.info(
        { ...log, truncated: outcome.truncated, stderr: outcome.stderr },
        "setup command finished",
      );
      setup[command.name] = outcome.truncated
        ? `${outcome.stdout}${TRUNCATION_MARKER}`
        : outcome.stdout;
      continue;
    }
    if (!command.optional) {
      options.logger.info(
        { ...log, stderr: outcome.stderr },
        "setup command failed; failing the run",
      );
      throw new SetupCommandError(command.name, failureDetail(outcome, timeoutMs) ?? reason);
    }
    options.logger.info({ ...log, stderr: outcome.stderr }, "optional setup command failed");
    // One line; the stderr tail is only logged.
    setup[command.name] = `(The setup command ${command.name} failed: ${reason}.)`;
  }
  return setup;
}

/**
 * Runs a task's teardown commands in order, each to the end or its timeout,
 * even after the run was aborted; their output and failures are logged and
 * the next one runs.
 */
export async function runTeardownCommands(
  commands: readonly TeardownCommand[],
  options: CommandOptions,
): Promise<void> {
  for (const command of commands) {
    const started = Date.now();
    const timeoutMs = command.timeoutSeconds * 1000;
    const outcome = await runCommand(resolveCommand(command.command, options.executables), {
      cwd: options.cwd,
      env: commandEnvFor(command.command, options),
      timeoutMs,
      maxStdoutBytes: command.maxOutputBytes,
    });
    const log = {
      name: command.name,
      exitCode: outcome.exitCode,
      durationMs: Date.now() - started,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    };
    const failure = failureDetail(outcome, timeoutMs);
    if (failure === null) options.logger.info(log, "teardown command finished");
    else options.logger.warn({ ...log, failure }, "teardown command failed");
  }
}
