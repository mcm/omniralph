import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AcceptedTaskTypes } from "@omniralph/shared";
import { TASK_TYPES, type TaskType } from "@omniralph/tasks";
import { z } from "zod";

/** Installables an agent accepts when its config doesn't say. */
export const DEFAULT_INSTALLABLE_ALLOW = ["@omniralph/*"] as const;

/**
 * An npm package name, optionally with `*` wildcards (each matching any run of
 * characters except `/`): `@scope/name`, `@scope/*` or `name`.
 */
const PackagePattern = z
  .string()
  .refine((value) => value !== "" && !/\s/.test(value) && value.split("/").length <= 2, {
    message: "must be an npm package name or a pattern like '@scope/*'",
  });

const AbsolutePath = z
  .string()
  .refine((value) => path.isAbsolute(value), { message: "must be an absolute path" });

/**
 * The agent's only local configuration. Everything else (concurrency, pool
 * limits, pinned repos) comes from the control panel
 * in every heartbeat response. The optional keys are left out when unset, so
 * rewriting the file (token rotation) never adds them; use the accessors below
 * for their defaults.
 */
export const AgentConfig = z.object({
  server: z.string(),
  agentId: z.string(),
  /** Rotated on every `/api/agent/token` call; reusing an old one revokes the agent. */
  refreshToken: z.string(),
  workspaceRoot: z.string(),
  /** Agent data (installables prefix, caches); default `~/.omniralph`. */
  dataDir: AbsolutePath.optional(),
  installables: z
    .object({
      /** Package-name patterns the `install` RPC accepts; default `["@omniralph/*"]`, `[]` allows none. */
      allow: z.array(PackagePattern).optional(),
    })
    .optional(),
  /** Absolute path prefixes the agent never executes, configured or discovered. */
  blockedExecPaths: z.array(AbsolutePath).optional(),
  /**
   * The task types the agent runs jobs of (`query`, `review`, `coding`; `system` jobs always
   * run): reported in every heartbeat and claim. Default: all of them.
   */
  acceptedTaskTypes: AcceptedTaskTypes.optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export function defaultConfigPath(home = homedir()): string {
  return path.join(home, ".config", "omniralph", "agent.json");
}

export function defaultWorkspaceRoot(home = homedir()): string {
  return path.join(home, ".omniralph", "repos");
}

/** The agent data directory: the parent of the default workspace root. */
export function defaultDataDir(home = homedir()): string {
  return path.join(home, ".omniralph");
}

export function dataDir(config: AgentConfig, home = homedir()): string {
  return config.dataDir ?? defaultDataDir(home);
}

/** The task types the agent runs (`acceptedTaskTypes`, default all), in `TASK_TYPES` order. */
export function acceptedTaskTypes(config: Pick<AgentConfig, "acceptedTaskTypes">): TaskType[] {
  const accepted = config.acceptedTaskTypes;
  return accepted ? TASK_TYPES.filter((type) => accepted.includes(type)) : [...TASK_TYPES];
}

function packagePatternRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`);
}

/** Whether `installables.allow` (default `["@omniralph/*"]`) accepts the package. */
export function installableAllowed(config: AgentConfig, packageName: string): boolean {
  const allow = config.installables?.allow ?? DEFAULT_INSTALLABLE_ALLOW;
  return allow.some((pattern) => packagePatternRegExp(pattern).test(packageName));
}

/**
 * `realpath` of `file`; for a missing file, the realpath of its deepest
 * existing ancestor joined with the rest (plain `path.resolve` when none
 * resolves).
 */
async function resolveReal(file: string): Promise<string> {
  const absolute = path.resolve(file);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return absolute;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function withinPrefix(file: string, prefix: string): boolean {
  if (file === prefix) return true;
  const base = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
  return file.startsWith(base);
}

/**
 * Whether `file` is covered by `blockedExecPaths`, matching whole path
 * segments. Symlinks are resolved on both sides, and the unresolved paths are
 * checked too, so neither a link into a blocked prefix nor a blocked link
 * escapes.
 */
export async function execPathBlocked(
  config: Pick<AgentConfig, "blockedExecPaths">,
  file: string,
): Promise<boolean> {
  const blocked = config.blockedExecPaths ?? [];
  if (blocked.length === 0) return false;
  const candidates = [path.resolve(file), await resolveReal(file)];
  for (const entry of blocked) {
    const prefixes = [path.resolve(entry), await resolveReal(entry)];
    if (
      candidates.some((candidate) => prefixes.some((prefix) => withinPrefix(candidate, prefix)))
    ) {
      return true;
    }
  }
  return false;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Validates and normalises the control panel URL: `https://` only, except
 * `http://localhost` / `http://127.0.0.1` for development.
 */
export function validateServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ConfigError(`invalid server URL '${input}'`);
  }
  const localHttp =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localHttp) {
    throw new ConfigError(
      `server URL must use https:// (http:// is only allowed for localhost and 127.0.0.1)`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError("server URL must not contain credentials, a query or a fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

/**
 * Reads the config file. Refuses a file that group or others can access: it
 * holds the agent's refresh token.
 */
export async function readConfig(file: string): Promise<AgentConfig> {
  let mode: number;
  try {
    mode = (await stat(file)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`${file} not found; run 'omniralph-agent enroll' first`);
    }
    throw error;
  }
  if ((mode & 0o077) !== 0) {
    throw new ConfigError(
      `${file} is accessible by group or others (mode ${(mode & 0o777).toString(8)}); run 'chmod 600 ${file}'`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new ConfigError(`${file} is not valid JSON`);
  }
  const parsed = AgentConfig.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) =>
        issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      )
      .join("; ");
    throw new ConfigError(`${file} is not a valid agent config (${issues})`);
  }
  return { ...parsed.data, server: validateServerUrl(parsed.data.server) };
}

/**
 * Writes the config atomically: a 0600 temp file in the same directory is
 * written and fsynced, then renamed over the old file. A crash leaves either
 * the old or the new file, never a truncated one.
 */
export async function writeConfig(file: string, config: AgentConfig): Promise<void> {
  await writePrivateJson(file, config);
}

/**
 * Writes a JSON file only the owner can read (0600), atomically (see
 * `writeConfig`).
 */
export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  // Persist the rename itself (best effort: not every platform can fsync a directory).
  try {
    const dirHandle = await open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // ignore
  }
}
