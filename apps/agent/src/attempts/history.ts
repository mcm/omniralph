import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  INSTALL_JOB_TYPE,
  JobRepository,
  JobTaskType,
  describeAttempt,
  type AttemptLabelContext,
  type JobPayload,
  type RunSpec,
} from "@omniralph/shared";
import { z } from "zod";
import { writePrivateJson } from "../config.js";
import type { Logger } from "../logger.js";
import { sessionTee, type SessionTee } from "../session/session.js";
import { JobTail, type TailEvent } from "./tail.js";

/** Finished attempts kept in `attempts.json`. */
export const ATTEMPT_HISTORY_SIZE = 200;
/** How long a finished attempt's live tail stays in memory. */
export const TAIL_RETENTION_MS = 10 * 60_000;

/** `<dataDir>/state/attempts.json`. */
export function attemptsPath(dataDir: string): string {
  return path.join(dataDir, "state", "attempts.json");
}

/** The repo an attempt worked in (never its clone URL). */
export const AttemptRepo = JobRepository.pick({ provider: true, fullPath: true });
export type AttemptRepo = z.infer<typeof AttemptRepo>;

export const ATTEMPT_OUTCOMES = ["completed", "failed", "canceled"] as const;
export const AttemptOutcome = z.enum(ATTEMPT_OUTCOMES);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

/** One attempt (a job this agent ran), as the agent page shows it. */
export const AttemptRecord = z.object({
  /** The job's ID. */
  id: z.string().min(1),
  /** The job type; never shown, the `label` is. */
  type: z.string().min(1),
  taskType: JobTaskType,
  /** The run it belongs to, when the payload names one. */
  runId: z.string().nullable(),
  repo: AttemptRepo.nullable(),
  /** Work item identifier, e.g. `SOC-1719`. */
  workItem: z.string().nullable(),
  /** The story's work item identifier, e.g. `SOC-1720`. */
  story: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** Null while running. */
  outcome: AttemptOutcome.nullable(),
  error: z.string().nullable(),
  /** `describeAttempt`'s sentence, e.g. "Built SOC-1720". */
  label: z.string(),
});
export type AttemptRecord = z.infer<typeof AttemptRecord>;

const AttemptsFile = z.object({
  v: z.literal(1),
  /** Newest first. */
  attempts: z.array(AttemptRecord),
});

/** An attempt with its live transcript (empty once the tail was dropped). */
export type AttemptDetail = AttemptRecord & { events: TailEvent[] };

/** What changed, for the page's live stream. */
export type AttemptChange =
  | { kind: "started" | "finished"; attempt: AttemptRecord }
  | { kind: "transcript"; id: string; events: TailEvent[] };

/** Longest error kept per attempt. */
const MAX_ERROR = 4_000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * What an attempt's label and page mention, read from its run spec's trigger
 * context or its payload (whatever of it is there): the run, repo, work item,
 * story, PR/MR number and package.
 */
export function attemptFacts(
  job: Pick<JobPayload, "type" | "payload">,
  runSpec?: Pick<RunSpec, "trigger" | "repository">,
): {
  runId: string | null;
  repo: AttemptRepo | null;
  workItem: string | null;
  story: string | null;
  context: AttemptLabelContext;
} {
  const source: Record<string, unknown> = runSpec?.trigger.context ?? job.payload;
  const parsedRepo = AttemptRepo.safeParse(runSpec?.repository ?? source.repository);
  const repo = parsedRepo.success ? parsedRepo.data : null;
  const workItem =
    text(field(source.epic, "identifier")) ?? text(field(source.issue, "identifier"));
  const story = text(field(source.story, "identifier"));
  const prNumber = source.prNumber;
  return {
    runId: text(source.runId) ?? text(job.payload.runId),
    repo,
    workItem,
    story,
    context: {
      workItem,
      story,
      repository: repo?.fullPath ?? null,
      provider: repo?.provider ?? null,
      pullRequestNumber: typeof prNumber === "number" ? prNumber : null,
      packageName: job.type === INSTALL_JOB_TYPE ? text(source.name) : null,
    },
  };
}

interface Running {
  record: AttemptRecord;
  context: AttemptLabelContext;
  tail: JobTail;
}

export interface AttemptHistoryOptions {
  /** `attempts.json`; unset: nothing is persisted (tests). */
  file?: string;
  logger: Logger;
  /** Finished attempts kept (default `ATTEMPT_HISTORY_SIZE`). */
  size?: number;
  /** How long a finished attempt's tail is kept (default `TAIL_RETENTION_MS`). */
  tailRetentionMs?: number;
  /** Events kept per tail (default `JOB_TAIL_SIZE`). */
  tailSize?: number;
  now?: () => Date;
}

/**
 * What this agent ran: the running attempts with their live transcript
 * tails, and the last `size` finished ones, persisted to `attempts.json`
 * (0600, written atomically) and loaded again on start. A finished
 * attempt's tail is dropped `tailRetentionMs` after it finished. Emits
 * `change` (`AttemptChange`) on every start, finish and transcript event.
 */
export class AttemptHistory extends EventEmitter<{ change: [AttemptChange] }> {
  private readonly active = new Map<string, Running>();
  /** Newest first. */
  private finished: AttemptRecord[] = [];
  /** Tails of finished attempts, until they expire. */
  private readonly finishedTails = new Map<string, { tail: JobTail; timer: NodeJS.Timeout }>();
  private writes: Promise<void> = Promise.resolve();
  private readonly size: number;
  private readonly tailRetentionMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: AttemptHistoryOptions) {
    super();
    this.size = options.size ?? ATTEMPT_HISTORY_SIZE;
    this.tailRetentionMs = options.tailRetentionMs ?? TAIL_RETENTION_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** Loads `attempts.json`; a missing file is an empty history, an invalid one is logged and ignored. */
  async load(): Promise<void> {
    const { file } = this.options;
    if (!file) return;
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.logger.warn({ err: error, file }, "couldn't read the attempt history");
      }
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      this.options.logger.warn(
        { err: error, file },
        "the attempt history isn't valid JSON; starting a new one",
      );
      return;
    }
    const parsed = AttemptsFile.safeParse(json);
    if (!parsed.success) {
      this.options.logger.warn(
        { file, issues: parsed.error.issues.slice(0, 5) },
        "the attempt history isn't valid; starting a new one",
      );
      return;
    }
    this.finished = parsed.data.attempts.slice(0, this.size);
  }

  /**
   * Records a job's start and opens its tail. Returns the `SessionTee` that
   * feeds the tail, for the job's context.
   */
  start(
    job: Pick<JobPayload, "id" | "type" | "taskType" | "payload">,
    runSpec?: RunSpec,
  ): SessionTee {
    const facts = attemptFacts(job, runSpec);
    const record: AttemptRecord = {
      id: job.id,
      type: job.type,
      taskType: job.taskType,
      runId: facts.runId,
      repo: facts.repo,
      workItem: facts.workItem,
      story: facts.story,
      startedAt: this.now().toISOString(),
      finishedAt: null,
      outcome: null,
      error: null,
      label: describeAttempt({ type: job.type, status: "running", context: facts.context }),
    };
    const tail = new JobTail({
      now: this.now,
      ...(this.options.tailSize !== undefined && { size: this.options.tailSize }),
    });
    tail.subscribe((event) =>
      this.emit("change", { kind: "transcript", id: job.id, events: [event] }),
    );
    // A redelivered job starting again replaces its earlier, unfinished entry.
    this.dropTail(job.id);
    this.active.set(job.id, { record, context: facts.context, tail });
    this.emit("change", { kind: "started", attempt: record });
    return sessionTee((event) => tail.event(event));
  }

  /** Records a job's outcome; its tail stays readable for `tailRetentionMs`. */
  finish(id: string, outcome: AttemptOutcome, error?: string | null): void {
    const running = this.active.get(id);
    if (!running) return;
    this.active.delete(id);
    const record: AttemptRecord = {
      ...running.record,
      finishedAt: this.now().toISOString(),
      outcome,
      error: error ? error.slice(0, MAX_ERROR) : null,
      label: describeAttempt({
        type: running.record.type,
        status: outcome,
        context: running.context,
      }),
    };
    this.finished = [record, ...this.finished.filter((a) => a.id !== id)].slice(0, this.size);
    const timer = setTimeout(() => this.dropTail(id), this.tailRetentionMs);
    timer.unref();
    this.finishedTails.set(id, { tail: running.tail, timer });
    this.persist();
    this.emit("change", { kind: "finished", attempt: record });
  }

  /** The running attempts, oldest first. */
  running(): AttemptRecord[] {
    return [...this.active.values()].map((r) => r.record);
  }

  /** The last `limit` finished attempts, newest first. */
  recent(limit = this.size): AttemptRecord[] {
    return this.finished.slice(0, Math.max(0, limit));
  }

  /** An attempt with its transcript so far, or undefined when it isn't known. */
  get(id: string): AttemptDetail | undefined {
    const running = this.active.get(id);
    if (running) return { ...running.record, events: running.tail.events() };
    const record = this.finished.find((a) => a.id === id);
    if (!record) return undefined;
    return { ...record, events: this.finishedTails.get(id)?.tail.events() ?? [] };
  }

  /** Resolves once every write so far is on disk (or failed and was logged). */
  flush(): Promise<void> {
    return this.writes;
  }

  /** Stops the tail timers and waits for the pending writes. */
  async close(): Promise<void> {
    for (const id of [...this.finishedTails.keys()]) this.dropTail(id);
    await this.flush();
  }

  private dropTail(id: string): void {
    const kept = this.finishedTails.get(id);
    if (!kept) return;
    clearTimeout(kept.timer);
    kept.tail.close();
    this.finishedTails.delete(id);
  }

  /** Writes the finished attempts, one write at a time, the latest state each time. */
  private persist(): void {
    const { file } = this.options;
    if (!file) return;
    this.writes = this.writes.then(async () => {
      try {
        await writePrivateJson(file, { v: 1, attempts: this.finished });
      } catch (error) {
        this.options.logger.warn({ err: error, file }, "couldn't save the attempt history");
      }
    });
  }
}
