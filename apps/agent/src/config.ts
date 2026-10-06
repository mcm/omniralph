import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * The agent's only local configuration. Everything else (concurrency, poll
 * interval, capabilities, topics, pinned repos) comes from the control panel
 * in every heartbeat response.
 */
export const AgentConfig = z.object({
  server: z.string(),
  agentId: z.string(),
  /** Rotated on every `/api/agent/token` call; reusing an old one revokes the agent. */
  refreshToken: z.string(),
  workspaceRoot: z.string(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export function defaultConfigPath(): string {
  return path.join(homedir(), ".config", "omniralph", "agent.json");
}

export function defaultWorkspaceRoot(): string {
  return path.join(homedir(), ".omniralph", "repos");
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
  if (!parsed.success) throw new ConfigError(`${file} is not a valid agent config`);
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
