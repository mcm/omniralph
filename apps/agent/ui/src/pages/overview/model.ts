/**
 * The Overview and Attempt pages' copy and pure helpers: the problem line, the summary
 * cells, elapsed times and an attempt's status line.
 */
import type { StatusTone } from "@omniralph/ui";
import type { AttemptRecord } from "../../../../src/attempts/history.js";
import type { LogEntry } from "../../../../src/logs/entries.js";
import { formatBytes } from "../../format.js";
import type { AgentUiState } from "../../state.js";
import { NOT_CHECKED, NOT_SIGNED_IN, SOURCE_LABELS } from "../claude/model.js";
import { updateTarget } from "../version/model.js";

export const NOTHING_RUNNING = "Nothing running";
export const NO_RECENT_WORK = "No recent work";
export const ATTEMPT_NOT_FOUND = "This attempt isn't on this agent.";
export const OPEN_RUN = "Open run in Omniralph";
export const NO_LOG_LINES = "No log lines";
export const NO_TRANSCRIPT = "No transcript for this attempt";
export const TRANSCRIPT_PENDING = "Nothing yet";
export const REVOKED = "This agent was revoked. Enroll it again to reconnect.";
export const CLAUDE_SIGNED_OUT = "Claude isn't signed in";

export interface Sentence {
  text: string;
  tone?: StatusTone;
}

const CLOCK = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const CLOCK_SECONDS = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** "10:42" in local time. */
export function clockTime(at: string | number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : CLOCK.format(date);
}

/** "10:42:07" in local time. */
export function clockTimeSeconds(at: string | number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : CLOCK_SECONDS.format(date);
}

/** "45s", "12m", "1h 5m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** The version an update is heading for, while one is under way; null otherwise. */
export function updatingTo(state: AgentUiState): string | null {
  const { update } = state;
  const phase = update.update?.state ?? "idle";
  if (phase !== "idle") return update.update?.version ?? updateTarget(state);
  if (update.request !== null) return update.request.version ?? updateTarget(state);
  return null;
}

/**
 * Overview's problem line, only when something is abnormal, first match wins: the control
 * panel can't be reached (a revoked agent can't reach it either, so revoked says why), the
 * agent is finishing its work to update, Claude isn't signed in.
 */
export function overviewProblem(state: AgentUiState): Sentence | null {
  const { connection } = state;
  if (connection.revoked) return { text: REVOKED, tone: "fail" };
  if (connection.unreachableSince !== null) {
    return {
      text: `Can't reach the control panel since ${clockTime(connection.unreachableSince)}`,
      tone: "fail",
    };
  }
  const phase = state.update.update?.state ?? "idle";
  if (phase === "draining" || (phase === "idle" && state.update.request !== null)) {
    return {
      text: `Finishing running work before updating to ${updatingTo(state)}`,
      tone: "neutral",
    };
  }
  if (state.claude?.status === "signed_out") return { text: CLAUDE_SIGNED_OUT, tone: "fail" };
  return null;
}

/** "2 of 4 busy", or "Idle". */
export function slotsText(state: AgentUiState): string {
  const busy = state.status.runningJobIds.length;
  return busy === 0 ? "Idle" : `${busy} of ${state.status.maxConcurrency} busy`;
}

/** Under the running version: "Up to date", "Updating to 2.0.4", "Pinned", "Update to 2.0.4 failed". */
export function versionDetail(state: AgentUiState): Sentence {
  const target = updatingTo(state);
  if (target !== null) return { text: `Updating to ${target}` };
  const report = state.update.update;
  if (report?.error) {
    const failed = report.version ?? state.update.failedVersions.at(-1) ?? null;
    return {
      text: failed === null ? "The last update failed" : `Update to ${failed} failed`,
      tone: "fail",
    };
  }
  if (state.settings.effective.versionPin !== null) return { text: "Pinned" };
  return { text: "Up to date" };
}

/** "Signed in" with its source, or "Not signed in" in the fail tone. */
export function claudeCell(claude: AgentUiState["claude"]): Sentence & { detail?: string } {
  if (claude === null) return { text: NOT_CHECKED };
  if (claude.status === "signed_out") return { text: NOT_SIGNED_IN, tone: "fail" };
  if (claude.status === "unknown") return { text: "Couldn't check" };
  return {
    text: "Signed in",
    ...(claude.source !== null && { detail: SOURCE_LABELS[claude.source] }),
  };
}

/** The filesystem that matters most: a low one, else the one with the least free space. */
export function diskCell(filesystems: AgentUiState["filesystems"]): Sentence & { detail?: string } {
  const sorted = [...filesystems].sort(
    (a, b) => Number(b.low) - Number(a.low) || a.freeBytes - b.freeBytes,
  );
  const fs = sorted[0];
  if (!fs) return { text: "Unknown" };
  return {
    text: `${formatBytes(fs.freeBytes)} free`,
    detail: `of ${formatBytes(fs.totalBytes)}`,
    ...(fs.low && { tone: "fail" as const }),
  };
}

/** How long an attempt ran, or has been running. */
export function attemptElapsed(
  attempt: Pick<AttemptRecord, "startedAt" | "finishedAt">,
  now: number,
): string {
  const end = attempt.finishedAt === null ? now : Date.parse(attempt.finishedAt);
  return formatDuration(end - Date.parse(attempt.startedAt));
}

/** "Running for 12m", "Finished in 4m", "Failed after 2m", "Stopped after 2m". */
export function attemptStatus(
  attempt: Pick<AttemptRecord, "startedAt" | "finishedAt" | "outcome">,
  now: number,
): Sentence {
  const elapsed = attemptElapsed(attempt, now);
  switch (attempt.outcome) {
    case null:
      return { text: `Running for ${elapsed}`, tone: "run" };
    case "completed":
      return { text: `Finished in ${elapsed}`, tone: "good" };
    case "failed":
      return { text: `Failed after ${elapsed}`, tone: "fail" };
    case "canceled":
      return { text: `Stopped after ${elapsed}`, tone: "neutral" };
  }
}

/** The run's page on the control panel. */
export function runUrl(server: string, runId: string): string {
  return `${server.replace(/\/+$/, "")}/runs/${encodeURIComponent(runId)}`;
}

function logKey(entry: LogEntry): string {
  return `${entry.time}\u0000${entry.level}\u0000${entry.msg}\u0000${JSON.stringify(entry.fields)}`;
}

/**
 * The attempt's log: the lines its page loaded, then the live lines (`logs` events) of the
 * same attempt not among them, oldest first.
 */
export function attemptLog(
  id: string,
  loaded: readonly LogEntry[],
  live: readonly LogEntry[],
): LogEntry[] {
  const seen = new Set(loaded.map(logKey));
  const added = live.filter((entry) => entry.fields.jobId === id && !seen.has(logKey(entry)));
  return [...loaded, ...added];
}
