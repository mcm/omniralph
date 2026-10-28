import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const AbsolutePath = z
  .string()
  .refine((value) => path.isAbsolute(value), { message: "must be an absolute path" });

/** The agent page's port when `ui.port` isn't set. */
export const DEFAULT_UI_PORT = 7410;

/** A host name the agent page answers to (`ui.allowedHosts`): no scheme, path or port. */
const UiHostName = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i, {
    message: "must be a host name",
  });

/** Keys of older configs that now live in `settings.json`, refused with a pointer there. */
export const MOVED_TO_SETTINGS = ["acceptedTaskTypes", "installables"] as const;

/**
 * The agent's identity and bootstrap (`agent.json`). Its machine settings
 * (slots, kinds, host tools, the installables allow-list, the version pin)
 * are in `<dataDir>/settings.json` (`LocalSettingsStore`). The optional keys
 * are left out when unset, so rewriting the file (token rotation) never adds
 * them; use the accessors below for their defaults.
 */
export const AgentConfig = z.object({
  server: z.string(),
  agentId: z.string(),
  /** Rotated on every `/api/agent/token` call; reusing an old one revokes the agent. */
  refreshToken: z.string(),
  workspaceRoot: z.string(),
  /** Agent data (installables prefix, caches); default `~/.omniralph`. */
  dataDir: AbsolutePath.optional(),
  /** Absolute path prefixes the agent never executes, configured or discovered. */
  blockedExecPaths: z.array(AbsolutePath).optional(),
  /** The agent page (`omniralph-agent ui`), served on 127.0.0.1 only. */
  ui: z
    .object({
      /** Default true. */
      enabled: z.boolean().optional(),
      /** Default `DEFAULT_UI_PORT`. */
      port: z.int().min(1).max(65535).optional(),
      /** Extra `Host` names the page answers to (e.g. a port-forwarding proxy); default none. */
      allowedHosts: z.array(UiHostName).max(20).optional(),
    })
    .optional(),
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
  const moved =
    typeof json === "object" && json !== null
      ? MOVED_TO_SETTINGS.filter((key) => key in json).map((key) => `${key} moved to settings.json`)
      : [];
  const parsed = AgentConfig.safeParse(json);
  if (!parsed.success || moved.length > 0) {
    const issues = [
      ...moved,
      ...(parsed.error?.issues ?? []).map((issue) =>
        issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      ),
    ].join("; ");
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

/** The exact text `writePrivateJson` writes for `value`. */
export function privateJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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
      await handle.writeFile(privateJsonText(value));
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
