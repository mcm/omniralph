import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  closeDb,
  createDb,
  getJob,
  insertJob,
  jobs,
  listRunIterations,
  organizations,
  type Database,
  type Job,
  type LoopRunRef,
  type RunIteration,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { PLAYBOOK_ROLES, type PlaybookRole } from "@omniralph/tasks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { advanceLoop, loopFeedback, loopOutcome, registerLoopAdapter, sinkMayLoop, startLoop } =
  await import("./loop");
const { jobHooks } = await import("@/lib/sinks");
const { BUILTIN_PLAYBOOK_SOURCE } = await import("@/lib/playbooks");

const databaseAvailable = testDatabaseAvailable();

const answered = (structured: unknown) => ({
  outcome: "answered",
  answer: null,
  structured,
  references: [],
  usage: { inputTokens: 1, outputTokens: 1 },
  durationMs: 1,
});

const verdict = (
  converged: boolean,
  extra: { findings?: string[]; metric?: { name: string; value: number } } = {},
) =>
  answered({
    converged,
    summary: converged ? "All findings hold up." : "Two findings are off.",
    findings: extra.findings ?? [],
    ...(extra.metric && { metric: { ...extra.metric, direction: "lower" } }),
  });

const iteration = (
  number: number,
  values: Partial<Pick<RunIteration, "verdict" | "metric">> = {},
): Pick<RunIteration, "number" | "verdict" | "metric" | "createdAt" | "finishedAt"> => ({
  number,
  verdict: values.verdict ?? "continue",
  metric: values.metric ?? null,
  createdAt: new Date(2026, 0, number),
  finishedAt: new Date(2026, 0, number),
});

/** A loop block naming its verifier playbook. */
const checked = { verifierPlaybookId: "builtin:check-findings" };

const lowerIsBetter = (value: number) => ({
  name: "open findings",
  value,
  direction: "lower" as const,
});

describe("loopOutcome", () => {
  const settings = { maxIterations: 5, stallRounds: 2 };

  it("stops when the verifier reports convergence", () => {
    expect(loopOutcome([iteration(1), iteration(2, { verdict: "converged" })], settings)).toBe(
      "converged",
    );
  });

  it("stops after maxIterations", () => {
    const four = [1, 2, 3, 4].map((n) => iteration(n));
    expect(loopOutcome(four, settings)).toBeNull();
    expect(loopOutcome([...four, iteration(5)], settings)).toBe("max-iterations");
  });

  it("stops when the metric hasn't beaten its best for stallRounds iterations", () => {
    const metrics = [5, 3, 4, 3].map((value, i) =>
      iteration(i + 1, { metric: lowerIsBetter(value) }),
    );
    expect(loopOutcome(metrics.slice(0, 3), settings)).toBeNull();
    expect(loopOutcome(metrics, settings)).toBe("stalled");
  });

  it("keeps going while the metric improves", () => {
    const metrics = [5, 4, 3, 2].map((value, i) =>
      iteration(i + 1, { metric: lowerIsBetter(value) }),
    );
    expect(loopOutcome(metrics, settings)).toBeNull();
  });
});

describe("loopFeedback", () => {
  it("is the verifier's summary and its findings as a list", () => {
    expect(loopFeedback({ summary: "Two are off.", findings: ["a.ts:3 is fine", "b.ts:9"] })).toBe(
      "Two are off.\n\n- a.ts:3 is fine\n- b.ts:9",
    );
    expect(loopFeedback({ summary: "Done.", findings: [] })).toBe("Done.");
  });
});

describe("sinkMayLoop", () => {
  it("is true for the sinks of looped query and review roles and the verifier's", () => {
    const looped = (Object.keys(PLAYBOOK_ROLES) as PlaybookRole[])
      .filter((role) => PLAYBOOK_ROLES[role].loop === "looped")
      .filter((role) => PLAYBOOK_ROLES[role].taskType !== "coding")
      .map((role) => PLAYBOOK_ROLES[role].sink);
    for (const sink of [...looped, PLAYBOOK_ROLES.verifier.sink])
      expect(sinkMayLoop(sink)).toBe(true);
    expect(sinkMayLoop("ralph-run")).toBe(false);
    expect(sinkMayLoop("chat-thread")).toBe(false);
    expect(sinkMayLoop("learned-rule")).toBe(false);
  });
});

describe.skipIf(!databaseAvailable)("the loop driver", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  /** What the adapter was asked to do, per run. */
  const calls = new Map<string, string[]>();
  const ends = new Map<string, string>();

  async function newJob(run: LoopRunRef, kind: "worker" | "verifier"): Promise<string> {
    const { job } = await insertJob(db, {
      organizationId: run.organizationId,
      type: `loop.${kind}`,
      taskType: "query",
      taskId: kind === "verifier" ? "builtin:correlate-findings" : "builtin:review-pr",
    });
    return job.id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    registerLoopAdapter("review", {
      async startWorker(_tx, run, it) {
        calls.get(run.id)!.push(`worker ${it.number}${it.feedback ? `: ${it.feedback}` : ""}`);
        return newJob(run, "worker");
      },
      async startVerifier(_tx, run, it, worker) {
        calls.get(run.id)!.push(`${it.verifierPlaybookId} ${it.number} of ${worker.type}`);
        return newJob(run, "verifier");
      },
      async finish(_tx, run, end) {
        ends.set(run.id, `${end.outcome} after ${end.iterations.length}`);
      },
    });
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  function newRun(): LoopRunRef {
    const run = { kind: "review" as const, id: randomUUID(), organizationId: orgId };
    calls.set(run.id, []);
    return run;
  }

  async function finishJob(jobId: string, result: Record<string, unknown> | null): Promise<Job> {
    const [job] = await db
      .update(jobs)
      .set(result ? { status: "completed", result } : { status: "failed", error: "boom" })
      .where(eq(jobs.id, jobId))
      .returning();
    return job!;
  }

  async function lastIteration(run: LoopRunRef): Promise<RunIteration> {
    return (await listRunIterations(db, run)).at(-1)!;
  }

  /** Completes the run's current worker, then its verifier with `answer`. */
  async function iterate(run: LoopRunRef, answer: Record<string, unknown>): Promise<void> {
    const working = await lastIteration(run);
    expect(working.status).toBe("working");
    await advanceLoop(db, await finishJob(working.workerJobId!, answered(null)), {
      status: "completed",
    });
    const verifying = await lastIteration(run);
    expect(verifying.status).toBe("verifying");
    await advanceLoop(db, await finishJob(verifying.verifierJobId!, answer), {
      status: "completed",
    });
  }

  it("runs one session for every single-session role and loops every other query and review role", async () => {
    for (const role of Object.keys(PLAYBOOK_ROLES) as PlaybookRole[]) {
      const { loop, taskType } = PLAYBOOK_ROLES[role];
      const run = newRun();
      const started = await startLoop(db, run, { role, loop: checked });
      if (loop === "none" || taskType === "coding") {
        expect(started, role).toBeNull();
        expect(await listRunIterations(db, run), role).toEqual([]);
      } else {
        expect(started, role).toMatchObject({ number: 1, status: "working" });
      }
    }
  });

  it("runs one session for a looped playbook that names no verifier", async () => {
    const run = newRun();
    expect(await startLoop(db, run, { role: "review", loop: { maxIterations: 4 } })).toBeNull();
    expect(await startLoop(db, run, { role: "triage" })).toBeNull();
    expect(await listRunIterations(db, run)).toEqual([]);
    expect(calls.get(run.id)).toEqual([]);
  });

  it("feeds the verifier's findings to the next worker and stops on convergence", async () => {
    const run = newRun();
    const first = (await startLoop(db, run, {
      role: "review",
      loop: { ...checked, maxIterations: 4 },
    }))!;
    expect(first).toMatchObject({
      number: 1,
      verifierPlaybookId: "builtin:check-findings",
      maxIterations: 4,
      stallRounds: 2,
      feedback: null,
    });
    expect(first.workerJobId).not.toBeNull();

    await iterate(run, verdict(false, { findings: ["a.ts:3 isn't a bug"] }));
    await iterate(run, verdict(true));

    const iterations = await listRunIterations(db, run);
    expect(iterations).toMatchObject([
      {
        number: 1,
        status: "done",
        verdict: "continue",
        summary: "Two findings are off.",
        findings: ["a.ts:3 isn't a bug"],
        outcome: null,
      },
      {
        number: 2,
        status: "done",
        verdict: "converged",
        feedback: "Two findings are off.\n\n- a.ts:3 isn't a bug",
        outcome: "converged",
      },
    ]);
    expect(iterations.every((it) => it.verifyingAt && it.finishedAt)).toBe(true);
    expect(calls.get(run.id)).toEqual([
      "worker 1",
      "builtin:check-findings 1 of loop.worker",
      "worker 2: Two findings are off.\n\n- a.ts:3 isn't a bug",
      "builtin:check-findings 2 of loop.worker",
    ]);
    expect(ends.get(run.id)).toBe("converged after 2");
  });

  it("stops at maxIterations", async () => {
    const run = newRun();
    await startLoop(db, run, { role: "triage", loop: { ...checked, maxIterations: 2 } });
    await iterate(run, verdict(false));
    await iterate(run, verdict(false));
    expect((await listRunIterations(db, run)).map((it) => it.outcome)).toEqual([
      null,
      "max-iterations",
    ]);
    expect(ends.get(run.id)).toBe("max-iterations after 2");
  });

  it("stops when the verifier's metric stalls, recording each iteration's metric", async () => {
    const run = newRun();
    await startLoop(db, run, {
      role: "review",
      loop: { ...checked, maxIterations: 10, stallRounds: 2 },
    });
    for (const value of [4, 2, 3, 2]) {
      await iterate(run, verdict(false, { metric: { name: "open findings", value } }));
    }
    const iterations = await listRunIterations(db, run);
    expect(iterations.map((it) => it.metric?.value)).toEqual([4, 2, 3, 2]);
    expect(iterations.at(-1)!.outcome).toBe("stalled");
    expect(ends.get(run.id)).toBe("stalled after 4");
  });

  it("fails the loop when the worker fails, without starting a verifier", async () => {
    const run = newRun();
    const first = (await startLoop(db, run, { role: "review", loop: checked }))!;
    const failed = await finishJob(first.workerJobId!, null);
    expect(await advanceLoop(db, failed, { status: "failed", error: "boom" })).toBe(true);
    expect(await lastIteration(run)).toMatchObject({
      status: "failed",
      outcome: "failed",
      error: "The worker failed: boom",
      verifierJobId: null,
    });
    expect(ends.get(run.id)).toBe("failed after 1");
  });

  it("fails the loop when the verifier doesn't answer with a verdict", async () => {
    const run = newRun();
    await startLoop(db, run, { role: "review", loop: checked });
    await iterate(run, answered({ looksGood: true }));
    expect(await lastIteration(run)).toMatchObject({ status: "failed", outcome: "failed" });
    expect(ends.get(run.id)).toBe("failed after 1");
  });

  it("ignores a replayed outcome and jobs outside any loop", async () => {
    const run = newRun();
    const first = (await startLoop(db, run, { role: "review", loop: checked }))!;
    const worker = await finishJob(first.workerJobId!, answered(null));
    await advanceLoop(db, worker, { status: "completed" });
    await advanceLoop(db, worker, { status: "completed" });
    expect(calls.get(run.id)).toEqual(["worker 1", "builtin:check-findings 1 of loop.worker"]);
    // A second start of the same run's loop returns its first iteration.
    expect((await startLoop(db, run, { role: "review", loop: checked }))!.id).toBe(first.id);

    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "other",
      taskType: "query",
    });
    expect(await advanceLoop(db, job, { status: "completed" })).toBe(false);
  });

  it("hands a verifier's result to the driver instead of its run-result sink", async () => {
    const run = newRun();
    await startLoop(db, run, { role: "review", loop: { ...checked, maxIterations: 3 } });
    const first = await lastIteration(run);
    const worker = await finishJob(first.workerJobId!, answered(null));
    await advanceLoop(db, worker, { status: "completed" });
    const verifierId = (await lastIteration(run)).verifierJobId!;
    const verifier = await finishJob(verifierId, verdict(true));

    const hooks = (await jobHooks(verifier, BUILTIN_PLAYBOOK_SOURCE))!;
    expect(hooks.isValidResult!(verifier.result)).toBe(true);
    await hooks.onCompleted!(db, (await getJob(db, verifierId))!);
    expect(await lastIteration(run)).toMatchObject({ verdict: "converged", outcome: "converged" });
    expect(ends.get(run.id)).toBe("converged after 1");
  });
});
