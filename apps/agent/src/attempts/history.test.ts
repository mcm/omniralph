import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  INSTALL_JOB_TYPE,
  RALPH_STORY_JOB_TYPE,
  REPO_SYNC_JOB_TYPE,
  REVIEW_TASK_JOB_TYPE,
  WORKTREE_CLEANUP_JOB_TYPE,
  type JobPayload,
  type RunSpec,
} from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../logger.js";
import { sessionRequest } from "../test/fake-query.js";
import {
  ATTEMPT_HISTORY_SIZE,
  AttemptHistory,
  TAIL_RETENTION_MS,
  attemptsPath,
  type AttemptChange,
  type AttemptOutcome,
} from "./history.js";

const REPO = { provider: "github" as const, fullPath: "acme/web/customer-portal" };
const RUN_ID = "7f1d6a1e-1c9b-4d6e-9f3a-2b0c1d2e3f40";

type Job = Pick<JobPayload, "id" | "type" | "taskType" | "payload">;

function job(
  type: string,
  taskType: JobPayload["taskType"],
  payload: Record<string, unknown> = {},
): Job {
  return { id: randomUUID(), type, taskType, payload };
}

/** The part of a run spec the history reads. */
function runSpec(context: Record<string, unknown>, repository = REPO): RunSpec {
  return { trigger: { kind: "linear.delegated", context }, repository } as unknown as RunSpec;
}

const story = () => ({
  job: job(RALPH_STORY_JOB_TYPE, "coding", { trigger: {} }),
  spec: runSpec({
    runId: RUN_ID,
    repository: REPO,
    epic: { identifier: "SOC-1719", title: "Portal" },
    story: { identifier: "SOC-1720", title: "Sign in" },
  }),
});
const review = () => ({
  job: job(REVIEW_TASK_JOB_TYPE, "review", { trigger: {} }),
  spec: runSpec({ reviewId: randomUUID(), repository: "acme/web/customer-portal", prNumber: 42 }),
});
const repoSync = () => ({ job: job(REPO_SYNC_JOB_TYPE, "system", { repository: REPO }) });
const install = () => ({
  job: job(INSTALL_JOB_TYPE, "system", { name: "@acme/tools", version: "1.2.0" }),
});
const cleanup = () => ({
  job: job(WORKTREE_CLEANUP_JOB_TYPE, "system", {
    runId: RUN_ID,
    repository: REPO,
    epic: { identifier: "SOC-1719" },
    action: "remove",
  }),
});

describe("AttemptHistory", () => {
  let dir: string;
  let clock: Date;
  const now = () => clock;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-attempts-"));
    clock = new Date("2026-10-28T10:00:00Z");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  function history(options: Partial<ConstructorParameters<typeof AttemptHistory>[0]> = {}) {
    return new AttemptHistory({ file: attemptsPath(dir), logger: silentLogger(), now, ...options });
  }

  describe("labels", () => {
    const cases: {
      name: string;
      make: () => { job: Job; spec?: RunSpec };
      running: string;
      outcomes: Record<AttemptOutcome, string>;
      facts: Record<string, unknown>;
    }[] = [
      {
        name: "a story",
        make: story,
        running: "Building SOC-1720",
        outcomes: {
          completed: "Built SOC-1720",
          failed: "Couldn't build SOC-1720",
          canceled: "Stopped building SOC-1720",
        },
        facts: { runId: RUN_ID, repo: REPO, workItem: "SOC-1719", story: "SOC-1720" },
      },
      {
        name: "a review",
        make: review,
        running: "Reviewing pull request #42 in customer-portal",
        outcomes: {
          completed: "Reviewed pull request #42 in customer-portal",
          failed: "Couldn't review pull request #42 in customer-portal",
          canceled: "Stopped reviewing pull request #42 in customer-portal",
        },
        facts: { runId: null, repo: REPO, workItem: null, story: null },
      },
      {
        name: "a repo sync",
        make: repoSync,
        running: "Syncing customer-portal",
        outcomes: {
          completed: "Synced customer-portal",
          failed: "Couldn't sync customer-portal",
          canceled: "Stopped syncing customer-portal",
        },
        facts: { runId: null, repo: REPO, workItem: null, story: null },
      },
      {
        name: "an install",
        make: install,
        running: "Installing @acme/tools",
        outcomes: {
          completed: "Installed @acme/tools",
          failed: "Couldn't install @acme/tools",
          canceled: "Stopped installing @acme/tools",
        },
        facts: { runId: null, repo: null, workItem: null, story: null },
      },
      {
        name: "a worktree cleanup",
        make: cleanup,
        running: "Cleaning up the SOC-1719 worktree",
        outcomes: {
          completed: "Cleaned up the SOC-1719 worktree",
          failed: "Couldn't clean up the SOC-1719 worktree",
          canceled: "Stopped cleaning up the SOC-1719 worktree",
        },
        facts: { runId: RUN_ID, repo: REPO, workItem: "SOC-1719", story: null },
      },
    ];

    it.each(cases)("labels $name in plain words, never its job type", (c) => {
      for (const outcome of ["completed", "failed", "canceled"] as const) {
        const attempts = history({ file: undefined });
        const { job: j, spec } = c.make();
        attempts.start(j, spec);
        const [running] = attempts.running();
        expect(running).toMatchObject({ id: j.id, type: j.type, label: c.running, ...c.facts });
        attempts.finish(j.id, outcome, outcome === "failed" ? "boom" : null);
        const finished = attempts.get(j.id)!;
        expect(finished.label).toBe(c.outcomes[outcome]);
        for (const label of [running!.label, finished.label]) {
          // `install` is also the plain verb ("Installed @acme/tools"); the others are dotted.
          expect(label).not.toBe(j.type);
          if (j.type.includes(".")) expect(label).not.toContain(j.type);
          expect(label).not.toMatch(/\b[a-z]+\.[a-z-]+\b/);
        }
      }
    });
  });

  it("records start and finish times, the outcome and the error", () => {
    const attempts = history({ file: undefined });
    const { job: j, spec } = story();
    attempts.start(j, spec);
    clock = new Date("2026-10-28T10:04:00Z");
    attempts.finish(j.id, "failed", "the gate failed");

    expect(attempts.running()).toEqual([]);
    expect(attempts.get(j.id)).toMatchObject({
      startedAt: "2026-10-28T10:00:00.000Z",
      finishedAt: "2026-10-28T10:04:00.000Z",
      outcome: "failed",
      error: "the gate failed",
      taskType: "coding",
    });
  });

  it("exposes running(), recent(limit), get(id) with the tail and change events", () => {
    const attempts = history({ file: undefined });
    const changes: AttemptChange[] = [];
    attempts.on("change", (change) => changes.push(change));
    const first = story();
    const second = repoSync();
    const sessions = attempts.start(first.job, first.spec);
    attempts.start(second.job);

    expect(attempts.running().map((a) => a.id)).toEqual([first.job.id, second.job.id]);
    expect(attempts.get("unknown")).toBeUndefined();

    // A session's events reach the tail through the tee the history returns.
    const runner = sessions.runner(async (request) => {
      request.onEvent?.({ type: "text", text: "Reading the PRD." });
      return { stop: "completed", output: "", usage: { inputTokens: 0, outputTokens: 0 } };
    });
    return runner(sessionRequest()).then(() => {
      const event = {
        type: "thought",
        body: "Reading the PRD.",
        parameter: null,
        at: "2026-10-28T10:00:00.000Z",
      };
      expect(attempts.get(first.job.id)!.events).toEqual([event]);

      attempts.finish(second.job.id, "completed");
      clock = new Date("2026-10-28T10:01:00Z");
      attempts.finish(first.job.id, "completed");
      expect(attempts.running()).toEqual([]);
      expect(attempts.recent(10).map((a) => a.id)).toEqual([first.job.id, second.job.id]);
      expect(attempts.recent(1).map((a) => a.id)).toEqual([first.job.id]);
      expect(attempts.get(first.job.id)!.events).toEqual([event]);

      expect(
        changes.map((c) =>
          c.kind === "transcript" ? `${c.kind}:${c.id}` : `${c.kind}:${c.attempt.id}`,
        ),
      ).toEqual([
        `started:${first.job.id}`,
        `started:${second.job.id}`,
        `transcript:${first.job.id}`,
        `finished:${second.job.id}`,
        `finished:${first.job.id}`,
      ]);
      expect(changes[2]).toEqual({ kind: "transcript", id: first.job.id, events: [event] });
    });
  });

  it(`drops a finished attempt's tail ${TAIL_RETENTION_MS / 60_000} minutes after it finished`, () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const attempts = history({ file: undefined });
    const { job: j, spec } = story();
    attempts.start(j, spec).runner(async (request) => {
      request.onEvent?.({ type: "text", text: "hello" });
      return { stop: "completed", output: "", usage: { inputTokens: 0, outputTokens: 0 } };
    })(sessionRequest());
    attempts.finish(j.id, "completed");

    vi.advanceTimersByTime(TAIL_RETENTION_MS - 1);
    expect(attempts.get(j.id)!.events).toHaveLength(1);
    vi.advanceTimersByTime(1);
    // The record stays; only its transcript is gone.
    expect(attempts.get(j.id)).toMatchObject({ id: j.id, outcome: "completed", events: [] });
  });

  it(`persists the last ${ATTEMPT_HISTORY_SIZE} finished attempts (0600, atomically) and reloads them`, async () => {
    const attempts = history();
    const ids: string[] = [];
    for (let i = 0; i < ATTEMPT_HISTORY_SIZE + 3; i++) {
      const { job: j } = repoSync();
      ids.push(j.id);
      attempts.start(j);
      attempts.finish(j.id, i % 2 ? "failed" : "completed", i % 2 ? "no network" : null);
    }
    const running = install();
    attempts.start(running.job);
    await attempts.close();

    const file = attemptsPath(dir);
    expect(file).toBe(path.join(dir, "state", "attempts.json"));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, "utf8")) as {
      v: number;
      attempts: { id: string }[];
    };
    expect(saved.v).toBe(1);
    expect(saved.attempts.map((a) => a.id)).toEqual(ids.slice(3).reverse());

    const reloaded = history();
    await reloaded.load();
    // Only finished attempts survive a restart.
    expect(reloaded.running()).toEqual([]);
    expect(reloaded.recent()).toEqual(attempts.recent());
    expect(reloaded.get(ids.at(-1)!)).toMatchObject({
      label: "Synced customer-portal",
      events: [],
    });
  });

  it("starts empty when attempts.json is missing or invalid", async () => {
    const missing = history();
    await missing.load();
    expect(missing.recent()).toEqual([]);

    await mkdir(path.join(dir, "state"), { recursive: true });
    for (const text of ["{not json", JSON.stringify({ v: 2, attempts: [] })]) {
      await writeFile(attemptsPath(dir), text);
      const logger = silentLogger();
      const warn = vi.spyOn(logger, "warn");
      const invalid = new AttemptHistory({ file: attemptsPath(dir), logger });
      await invalid.load();
      expect(invalid.recent()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });
});
