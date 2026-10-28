/** Attempt fixtures for the Overview and Attempt page tests, labeled as the daemon labels them. */
import { RALPH_STORY_JOB_TYPE, describeAttempt, type AttemptLabelContext } from "@omniralph/shared";
import type { AttemptRecord } from "../../../../src/attempts/history.js";
import type { LogEntry } from "../../../../src/logs/entries.js";
import type { AttemptPageState } from "./queries.js";

export const RUN_ID = "7f1d6a1e-1c9b-4d6e-9f3a-2b0c1d2e3f40";
export const REPO = { provider: "github" as const, fullPath: "acme/customer-portal" };

export const minutesAgo = (minutes: number, now = Date.now()) =>
  new Date(now - minutes * 60_000 - 5_000).toISOString();

let next = 0;

/** A story attempt for SOC-1720 of SOC-1719, running unless `outcome` says. */
export function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  next += 1;
  const outcome = overrides.outcome ?? null;
  const type = overrides.type ?? RALPH_STORY_JOB_TYPE;
  const context: AttemptLabelContext = {
    workItem: overrides.workItem === undefined ? "SOC-1719" : overrides.workItem,
    story: overrides.story === undefined ? "SOC-1720" : overrides.story,
    repository: REPO.fullPath,
    provider: REPO.provider,
  };
  return {
    id: `job-${next}`,
    type,
    taskType: "coding",
    runId: RUN_ID,
    repo: REPO,
    workItem: context.workItem ?? null,
    story: context.story ?? null,
    startedAt: minutesAgo(12),
    finishedAt: outcome === null ? null : minutesAgo(1),
    outcome,
    error: null,
    label: describeAttempt({ type, status: outcome ?? "running", context }),
    ...overrides,
  };
}

export function attemptPage(
  record: AttemptRecord,
  extra: Partial<Pick<AttemptPageState, "events" | "log">> = {},
): AttemptPageState {
  return { ...record, events: [], log: [], ...extra };
}

export function logLine(jobId: string, msg: string, overrides: Partial<LogEntry> = {}): LogEntry {
  return { time: Date.now(), level: "info", msg, fields: { jobId }, ...overrides };
}
