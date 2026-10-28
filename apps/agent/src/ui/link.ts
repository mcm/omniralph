/**
 * `ui.json` next to `agent.json`: where the running agent serves its page and
 * the token that opens it. The daemon writes it (0600) at start and removes it
 * on shutdown; `omniralph-agent ui` reads it.
 */
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writePrivateJson } from "../config.js";
import type { FetchFn } from "../api.js";
import { uiCookieName } from "./server.js";

export const UiLink = z.object({
  pid: z.int().positive(),
  port: z.int().min(1).max(65535),
  url: z.string(),
  startedAt: z.string(),
  token: z.string().min(1),
});
export type UiLink = z.infer<typeof UiLink>;

export function uiLinkPath(configPath: string): string {
  return path.join(path.dirname(configPath), "ui.json");
}

export async function writeUiLink(file: string, link: UiLink): Promise<void> {
  await writePrivateJson(file, link);
}

/** The link, or null when there's none or it isn't valid. */
export async function readUiLink(file: string): Promise<UiLink | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = UiLink.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Removes the link, unless another process has written its own since. */
export async function removeUiLink(file: string, pid: number): Promise<void> {
  const link = await readUiLink(file).catch(() => null);
  if (link && link.pid !== pid) return;
  await rm(file, { force: true });
}

/** The URL `omniralph-agent ui` prints. */
export function uiPageUrl(link: Pick<UiLink, "url" | "token">): string {
  return `${link.url}/?token=${link.token}`;
}

/** Whether a process with this PID runs (one we may not signal still counts). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether the page at `link` answers `GET /api/ping` as `agentId` (not some
 * other agent, or another program, now on that port).
 */
export async function pingUiLink(
  link: UiLink,
  agentId: string,
  fetchFn: FetchFn,
  timeoutMs = 3_000,
): Promise<boolean> {
  try {
    const response = await fetchFn(`${link.url}/api/ping`, {
      headers: { cookie: `${uiCookieName(link.port)}=${link.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { agentId?: unknown };
    return body.agentId === agentId;
  } catch {
    return false;
  }
}

/** The command that opens `url` in the default browser on `platform`. */
export function openerCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  // `start`'s first quoted argument is the window title.
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/** Runs the platform's opener for `url`, detached; rejects when it can't be started. */
export function openInBrowser(url: string, platform = process.platform): Promise<void> {
  const { command, args } = openerCommand(platform, url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
