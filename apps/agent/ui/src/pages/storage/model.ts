/** The Storage page's copy: item names, filesystem names and each repo's last sync. */
import type { StatusTone } from "@omniralph/ui";
import type { StorageFilesystem, StorageItemKey, StoredRepo } from "../../../../src/storage.js";
import type { StorageState } from "../../../../src/ui/machine-routes.js";
import { formatBytes, relativeTime } from "../../format.js";

export const ITEM_LABELS: Record<StorageItemKey, string> = {
  repo_cache: "Repo cache",
  worktrees: "Worktrees",
  branch_worktrees: "Branch worktrees",
  packages: "Packages",
  caches: "Caches",
  logs: "Logs",
};

export const NO_REPOS = "No repos cached yet";
export const NO_SYNC = "No sync recorded";
export const NEVER_FETCHED = "Never";

/** "Workspace", "Data", or "Workspace and data" when both are on one filesystem. */
export function filesystemLabel(fs: StorageFilesystem, roots: StorageState["roots"]): string {
  const workspace = fs.paths.includes(roots.workspaceRoot);
  const data = fs.paths.includes(roots.dataDir);
  if (workspace && data) return "Workspace and data";
  if (workspace) return "Workspace";
  if (data) return "Data";
  return fs.paths[0] ?? "Disk";
}

export function freeSpace(fs: StorageFilesystem): {
  text: string;
  detail: string;
  tone?: StatusTone;
} {
  return {
    text: `${formatBytes(fs.freeBytes)} free`,
    detail: `of ${formatBytes(fs.totalBytes)}`,
    ...(fs.low && { tone: "fail" as const }),
  };
}

/** The repository's own name: `customer-portal` for `acme/customer-portal`. */
export function repoName(repo: Pick<StoredRepo, "fullPath">): string {
  return repo.fullPath.split("/").at(-1) ?? repo.fullPath;
}

/**
 * "Synced customer-portal 10 minutes ago", or "Couldn't sync customer-portal: <error>" in the
 * fail tone.
 */
export function lastSyncText(
  repo: Pick<StoredRepo, "fullPath" | "lastSync">,
  now: number,
): { text: string; tone?: StatusTone } {
  const sync = repo.lastSync;
  if (sync === null) return { text: NO_SYNC };
  const name = repoName(repo);
  if (sync.outcome === "failed") {
    return {
      text: sync.error ? `Couldn't sync ${name}: ${sync.error}` : `Couldn't sync ${name}`,
      tone: "fail",
    };
  }
  if (sync.outcome === "canceled") {
    return { text: `Stopped syncing ${name} ${relativeTime(sync.at, now)}` };
  }
  return { text: `Synced ${name} ${relativeTime(sync.at, now)}` };
}
