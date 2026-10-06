import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** Env var through which job subprocesses (e.g. the `git-credential` helper) get their job token. */
export const JOB_TOKEN_ENV = "OMNIRALPH_JOB_TOKEN";
export const JOB_ID_ENV = "OMNIRALPH_JOB_ID";
export const SERVER_ENV = "OMNIRALPH_SERVER";

/**
 * The environment for a process a capability spawns for a job: the agent's
 * environment without any `OMNIRALPH_*` variable, plus the job's ID, the
 * server URL and the job token.
 * The agent's refresh and access tokens only live in the daemon's memory and
 * config file and are never part of it.
 */
export function jobProcessEnv(
  job: { jobId: string; jobToken: string; server: string },
  base: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries({ ...base, ...extra })) {
    if (name.startsWith("OMNIRALPH_")) continue;
    env[name] = value;
  }
  env[JOB_TOKEN_ENV] = job.jobToken;
  env[JOB_ID_ENV] = job.jobId;
  env[SERVER_ENV] = job.server;
  return env;
}

/** `env` without any `OMNIRALPH_*` variable (the job token, ID and server). */
export function withoutJobEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("OMNIRALPH_")));
}

/** Spawns a job subprocess with `jobProcessEnv` (any `env` option is merged in, minus `OMNIRALPH_*`). */
export function spawnJobProcess(
  job: { jobId: string; jobToken: string; server: string },
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(command, args, { ...options, env: jobProcessEnv(job, process.env, options.env) });
}
