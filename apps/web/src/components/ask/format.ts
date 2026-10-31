import type { AskMessageView } from "@/lib/api/ask";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** How long an ask took, as its answer's meta line says it: "41s", "3m 12s", "1h 4m". */
export function askDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / SECOND));
  if (seconds < 60) return `${seconds}s`;
  if (seconds * SECOND < HOUR) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor((seconds * SECOND) / HOUR);
  const minutes = Math.floor(((seconds * SECOND) % HOUR) / MINUTE);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** "1 file", "3 files". */
export function fileCount(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

/**
 * The badges after "Om" on an answer that came from an ask run: "read-only", "read 3 files",
 * "41s" (no duration while it isn't known). Null for any other Om message.
 */
export function omRunMeta(run: AskMessageView["run"]): string[] | null {
  if (!run) return null;
  const parts = ["read-only", `read ${fileCount(run.filesRead)}`];
  if (run.durationMs !== null) parts.push(askDuration(run.durationMs));
  return parts;
}

/** A repo's short name for a sentence: the last segment of its path ("customer-portal"). */
export function repoShortName(fullPath: string): string {
  const trimmed = fullPath.replace(/\/+$/, "");
  return trimmed.split("/").at(-1) || fullPath;
}
