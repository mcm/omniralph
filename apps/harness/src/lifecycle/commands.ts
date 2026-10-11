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
  /** Why the command couldn't start (e.g. no `bash`). */
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

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/**
 * Runs `command` with `bash -lc` in its own process group, keeping at most
 * `maxStdout` characters of stdout (the rest is drained, not buffered) and
 * the tail of stderr. After `timeoutMs`, or when `signal` aborts, the whole
 * group gets SIGTERM, then SIGKILL. Never rejects.
 */
export function runCommand(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxStdout: number;
    signal?: AbortSignal;
  },
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let truncated = false;
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn("bash", ["-lc", command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      const room = options.maxStdout - stdout.length;
      if (chunk.length > room) {
        stdout += chunk.slice(0, room);
        truncated = true;
      } else {
        stdout += chunk;
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

/** Why a command failed, in one line plus its stderr tail; null when it succeeded. */
export function failureDetail(outcome: CommandOutcome, timeoutMs: number): string | null {
  let what: string;
  if (outcome.spawnError !== undefined) what = `it couldn't start (${outcome.spawnError})`;
  else if (outcome.timedOut) {
    what = `it timed out after ${timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`}`;
  } else if (outcome.exitCode === 0) return null;
  else if (outcome.exitCode === null) what = "it was killed";
  else what = `it exited with code ${outcome.exitCode}`;
  return outcome.stderr ? `${what}: ${outcome.stderr}` : what;
}

/**
 * Runs a task's setup commands in order and returns the `setup` variables:
 * each command's stdout by name, cut to its `maxOutputChars` and marked when
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
    const outcome = await runCommand(command.command, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: command.timeoutMs,
      maxStdout: command.maxOutputChars,
      signal: options.signal,
    });
    options.signal.throwIfAborted();
    const log = {
      name: command.name,
      exitCode: outcome.exitCode,
      durationMs: Date.now() - started,
    };
    const failure = failureDetail(outcome, command.timeoutMs);
    if (failure === null) {
      options.logger.info({ ...log, truncated: outcome.truncated }, "setup command finished");
      setup[command.name] = outcome.truncated
        ? `${outcome.stdout}${TRUNCATION_MARKER}`
        : outcome.stdout;
      continue;
    }
    if (!command.optional) {
      options.logger.info(log, "setup command failed; failing the run");
      throw new SetupCommandError(command.name, failure);
    }
    options.logger.info(log, "optional setup command failed");
    setup[command.name] = `(The setup command ${command.name} failed: ${failure})`;
  }
  return setup;
}

/**
 * Runs a task's teardown commands in order, each to the end or its timeout,
 * even after the run was aborted; a failure is logged and the next one runs.
 */
export async function runTeardownCommands(
  commands: readonly TeardownCommand[],
  options: CommandOptions,
): Promise<void> {
  for (const [index, command] of commands.entries()) {
    const started = Date.now();
    const outcome = await runCommand(command.command, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: command.timeoutMs,
      maxStdout: 0,
    });
    const log = { index, exitCode: outcome.exitCode, durationMs: Date.now() - started };
    const failure = failureDetail(outcome, command.timeoutMs);
    if (failure === null) options.logger.info(log, "teardown command finished");
    else options.logger.warn({ ...log, failure }, "teardown command failed");
  }
}
