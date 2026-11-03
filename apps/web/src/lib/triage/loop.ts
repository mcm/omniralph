import "server-only";
import {
  getJob,
  getTriageRun,
  insertJob,
  listRunIterations,
  pinnedAgentFor,
  setTriageRunJob,
  updateRunIteration,
  ACTIVE_TRIAGE_RUN_STATUSES,
  type Database,
  type Job,
  type LoopRunRef,
  type NewJobInput,
  type RunIteration,
  type TriageRun,
} from "@omniralph/db";
import { previousResultContext, type TriageTemplateContext } from "@omniralph/ralph";
import {
  planCritiqueContext,
  RunSpecJobPayload,
  TRIAGE_CRITIQUE_JOB_TYPE,
  type TriageCritiqueTriggerContext,
  type TriageRevision,
  type TriageRound,
} from "@omniralph/shared";
import { playbookLoopSettings, type Playbook } from "@omniralph/tasks";
import type { JobDispatcher } from "@/lib/dispatch";
import { syncJobsDueFromPostgres } from "@/lib/dispatch/due";
import { getPlaybookTask, organizationPlaybooks, taskJobInput } from "@/lib/playbooks";
import {
  registerLoopAdapter,
  startLoop,
  type LoopAdapter,
  type LoopExecutor,
  type LoopVerdict,
} from "@/lib/runs/loop";
import { applyTriageAndContinue, readTriageResult, type TriageJobDeps } from "./apply";
import {
  critiqueRequest,
  draftRound,
  needsCritique,
  readCritique,
  readRound,
  roundFindings,
  roundPassed,
  roundSummary,
  unresolvedQuestions,
  unusableRound,
} from "./rounds";

/**
 * Triage as a loop (ADR 0013, run kind `triage`, `run_id` the `triage_runs`
 * row). Each round:
 *
 * 1. The worker is a `triage.run` job of `builtin:triage` that drafts the work
 *    item; from the second round on it gets the previous round's draft (as its
 *    `previousResult`) and what the checks found (`revision`). It is the run's
 *    current job; its sink doesn't apply it (`onTriageJobCompleted`).
 * 2. The checks: the work item lint (`lintDraft`), run here as the worker
 *    finishes, and the plan critic, a `triage.critique-plan` job of the loop's
 *    verifier playbook (`builtin:critique-plan`) that judges the draft against
 *    the rubric of its size. A draft that isn't a usable triage fails the lint
 *    with why; it and a Feature's recommendation get no critic.
 * 3. Both checks passing ends the loop; otherwise the lint failures and the
 *    critic's unmet items and questions are the next round's feedback, until
 *    the loop's cap (the playbook's `loop.maxIterations`).
 *
 * Each round is recorded on its iteration (`details`, a `TriageRound`: the
 * draft, the lint result and the critique). When the loop ends, the last
 * usable draft is applied to the tracker as a single session's is
 * (`applyTriageJob`); unless it passed both checks, every lint failure and
 * unmet critic item left becomes an open question on the work item (and so
 * does a critic that couldn't judge it), which keeps it Needs refining and
 * unstartable (`refuseOpenQuestions`) until a person answers.
 *
 * A triage run loops again for each reply or retry: its new loop numbers on
 * after the last one's iterations, its first iteration the one without feedback.
 */

/** The loop run of triage run `run`. */
export function triageLoopRun(run: Pick<TriageRun, "id" | "organizationId">): LoopRunRef {
  return { kind: "triage", id: run.id, organizationId: run.organizationId };
}

/** The iterations of the run's latest loop: from its last first iteration (one without feedback) on. */
export function latestLoop<T extends Pick<RunIteration, "feedback">>(
  iterations: readonly T[],
): T[] {
  const start = iterations.findLastIndex((it) => it.feedback === null);
  return iterations.slice(Math.max(start, 0));
}

/** The pool or a transaction as the `@omniralph/db` queries take it. */
function asDb(db: LoopExecutor): Database {
  return db as Database;
}

/**
 * Inserts the run's next `triage.run` job (`jobInput`, targeted at its repository's pinned
 * agent) as its current job, as the first round of a new loop when the triage playbook names
 * a critic (`loop.verifierPlaybookId`; its cap counted from this loop's first round), else as
 * a single session whose sink applies it. Then makes it claimable and wakes its agents.
 */
export async function startTriageJob(
  db: Database,
  dispatcher: Pick<JobDispatcher, "republish">,
  run: TriageRun,
  playbook: Pick<Playbook, "role" | "loop">,
  jobInput: NewJobInput,
): Promise<Job> {
  let job: Job | undefined;
  const insert = async (tx: LoopExecutor) => {
    const target = jobInput.repositoryId
      ? await pinnedAgentFor(asDb(tx), jobInput.organizationId, jobInput.repositoryId)
      : null;
    ({ job } = await insertJob(asDb(tx), { ...jobInput, targetAgentId: target }));
    await setTriageRunJob(asDb(tx), run.id, job.id);
    return job.id;
  };
  const loopRun = triageLoopRun(run);
  const settings = playbookLoopSettings(playbook);
  const after = (await listRunIterations(db, loopRun)).at(-1)?.number ?? 0;
  const iteration = await startLoop(db, loopRun, playbook, {
    number: after + 1,
    limits: { maxIterations: after + (settings?.maxIterations ?? 1) },
    startWorker: insert,
  });
  if (!iteration) await db.transaction(insert);
  if (!job) throw new Error(`Triage run ${run.id} started no job`);
  await dispatcher.republish(job.id);
  return job;
}

/** Whether triage run `run` still waits on `workerJobId`, the loop's current worker. */
function waitsOn(run: TriageRun | null, workerJobId: string): run is TriageRun {
  return (
    run !== null &&
    run.currentJobId === workerJobId &&
    (ACTIVE_TRIAGE_RUN_STATUSES as readonly string[]).includes(run.status)
  );
}

/** The verdict of a round whose run ended meanwhile (stopped, or a newer job took over). */
const RUN_OVER: LoopVerdict = {
  converged: true,
  summary: "The triage run moved on meanwhile, so the loop stops.",
  findings: [],
};

const MAX_FINDINGS = 100;
const MAX_FINDING_LENGTH = 5_000;

/** The loop's verdict on a round: converged once both checks passed, else what to revise. */
function roundVerdict(round: TriageRound): LoopVerdict {
  return {
    converged: roundPassed(round),
    summary: roundSummary(round),
    findings: roundFindings(round)
      .slice(0, MAX_FINDINGS)
      .map((f) => (f.length > MAX_FINDING_LENGTH ? `${f.slice(0, MAX_FINDING_LENGTH - 1)}…` : f)),
  };
}

/** The round `job` (a completed worker) drafted, with its lint. */
function workerRound(job: Pick<Job, "result">): TriageRound {
  const read = readTriageResult(job.result);
  return "problem" in read ? unusableRound(read.problem) : draftRound(read.triage);
}

/**
 * The latest round of `iterations` before `number` whose worker drafted a usable triage, with
 * its job; null when none did.
 */
async function lastUsableRound(
  db: LoopExecutor,
  iterations: readonly RunIteration[],
  number: number,
): Promise<{ iteration: RunIteration; round: TriageRound; worker: Job } | null> {
  for (const iteration of [...iterations].reverse()) {
    if (iteration.number >= number || !iteration.workerJobId) continue;
    const round = readRound(iteration.details);
    if (!round?.draft) continue;
    const worker = await getJob(asDb(db), iteration.workerJobId);
    if (worker) return { iteration, round, worker };
  }
  return null;
}

const triageLoopAdapter: LoopAdapter = {
  /**
   * A round after the first: the loop's first job again, given the last usable draft as its
   * previous triage and what the checks found as its revision.
   */
  async startWorker(db, run, iteration) {
    const loop = latestLoop(
      (await listRunIterations(db, run)).filter((it) => it.number <= iteration.number),
    );
    const first = loop[0]?.workerJobId ? await getJob(asDb(db), loop[0].workerJobId) : null;
    if (!first) throw new Error(`Triage run ${run.id}'s loop has no first job`);
    const payload = RunSpecJobPayload.parse(first.payload);
    const context = payload.trigger.context as Record<string, unknown>;
    const previous = await lastUsableRound(db, loop, iteration.number);
    const read = previous ? readTriageResult(previous.worker.result) : null;
    const previousResult: TriageTemplateContext["previousResult"] =
      read && "triage" in read ? previousResultContext(read.triage) : null;
    const start = loop[0]!.number;
    const revision: TriageRevision = {
      round: iteration.number - start + 1,
      maxRounds: iteration.maxIterations - start + 1,
      feedback: iteration.feedback ?? "Revise the draft.",
    };
    const { job } = await insertJob(asDb(db), {
      organizationId: first.organizationId,
      type: first.type,
      taskType: first.taskType,
      taskId: first.taskId,
      minAgentVersion: first.minAgentVersion,
      requiredInstallables: first.requiredInstallables,
      requiredHostTools: first.requiredHostTools,
      payload: {
        ...payload,
        trigger: {
          ...payload.trigger,
          context: {
            ...context,
            previousResult: previousResult ?? context.previousResult ?? null,
            revision,
          },
        },
      },
      repositoryId: first.repositoryId,
      triageRunId: run.id,
      dedupeKey: `triage:${run.id}`,
      targetAgentId: first.repositoryId
        ? await pinnedAgentFor(asDb(db), first.organizationId, first.repositoryId)
        : null,
    });
    await setTriageRunJob(asDb(db), run.id, job.id);
    return job.id;
  },

  /**
   * The round's checks: the lint at once, recorded on the iteration, then the plan critic (a
   * run of the loop's verifier playbook in a checkout of the worker's), unless there's nothing
   * for it to judge (an unusable draft, a Feature's recommendation) or no critic that can run.
   */
  async startVerifier(db, run, iteration, worker) {
    if (!waitsOn(await getTriageRun(asDb(db), run.id), worker.id)) return { verdict: RUN_OVER };
    const round = workerRound(worker);
    await updateRunIteration(asDb(db), iteration.id, { details: round });
    if (!needsCritique(round)) return { verdict: roundVerdict(round) };

    const definitions = organizationPlaybooks(asDb(db), run.organizationId);
    const task = await getPlaybookTask(definitions, iteration.verifierPlaybookId);
    if (!task || task.taskType !== "query" || !task.triggers.includes("run.invoked")) {
      return {
        verdict: {
          converged: true,
          summary: `${iteration.verifierPlaybookId} isn't a plan critic that can run, so the draft wasn't critiqued.`,
          findings: [],
        },
      };
    }
    const payload = RunSpecJobPayload.parse(worker.payload);
    const repository = (payload.trigger.context as { repository?: unknown }).repository;
    const context: TriageCritiqueTriggerContext = {
      invoker: { kind: "triage-run", id: run.id },
      repository: typeof repository === "string" ? repository : null,
      round: iteration.number,
      critique: planCritiqueContext(critiqueRequest(round.draft)),
    };
    const { job } = await insertJob(asDb(db), {
      organizationId: run.organizationId,
      type: TRIAGE_CRITIQUE_JOB_TYPE,
      ...(await taskJobInput(definitions, task, {
        trigger: { kind: "run.invoked", context },
        ...(worker.repositoryId && payload.ref
          ? { repositoryId: worker.repositoryId, ref: payload.ref }
          : {}),
      })),
      triageRunId: run.id,
      dedupeKey: `triage-critique:${run.id}:${iteration.number}`,
      targetAgentId: worker.repositoryId
        ? await pinnedAgentFor(asDb(db), run.organizationId, worker.repositoryId)
        : null,
    });
    return job.id;
  },

  /**
   * The round's verdict once the critic answered: its critique is recorded with the round. A
   * critic that didn't answer with a critique stops the loop (its draft is applied with the
   * question of checking it by hand).
   */
  async judge(db, run, iteration, verifier) {
    const worker = iteration.workerJobId ? await getJob(asDb(db), iteration.workerJobId) : null;
    if (!worker || !waitsOn(await getTriageRun(asDb(db), run.id), worker.id)) return RUN_OVER;
    const critique = readCritique(verifier.result);
    if (!critique) {
      return {
        converged: true,
        summary: "The plan critic didn't answer with a critique, so the loop stops.",
        findings: [],
      };
    }
    const round: TriageRound = {
      ...(readRound(iteration.details) ?? workerRound(worker)),
      critique,
    };
    await updateRunIteration(asDb(db), iteration.id, { details: round });
    return roundVerdict(round);
  },

  /** The tracker is written once the driver's transaction committed (`afterCommit`). */
  async finish() {},

  /** Makes the loop's new jobs claimable, and applies the loop's draft once it ended. */
  async afterCommit(db, run) {
    const iterations = await listRunIterations(db, run);
    const last = iterations.at(-1);
    await syncJobsDueFromPostgres(
      db,
      [last?.workerJobId, last?.verifierJobId].filter((id): id is string => Boolean(id)),
    );
    if (!last?.outcome) return;
    try {
      await applyTriageLoop(db, run, latestLoop(iterations));
    } catch (error) {
      console.error(`Applying the end of triage run ${run.id}'s loop failed`, error);
    }
  },
};

/** The open question left when the critic couldn't judge the draft applied. */
export function uncritiquedQuestion(reason: string): string {
  const why = reason.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return `The plan critic couldn't check this draft (${why}). Does the plan meet the rubric for its size as it is?`;
}

/**
 * Applies the end of triage run `run`'s loop (`iterations`, its last carrying the outcome) to
 * the tracker, once: the last usable draft, with what still failed its checks as open
 * questions unless it passed both, through `applyTriageAndContinue` (claimed with the run's
 * current job, the last round's worker). Nothing happens when the run has moved on (stopped,
 * or a failed worker already ended it). Without any usable draft, the last worker's result is
 * applied, which fails the run as a single session's would.
 */
export async function applyTriageLoop(
  db: Database,
  run: LoopRunRef,
  iterations: readonly RunIteration[],
  deps?: TriageJobDeps,
): Promise<void> {
  const last = iterations.at(-1);
  if (!last?.workerJobId) return;
  const triageRun = await getTriageRun(db, run.id);
  if (!waitsOn(triageRun, last.workerJobId)) return;
  const current = await getJob(db, last.workerJobId);
  if (current?.status !== "completed") return;
  const chosen = await lastUsableRound(db, iterations, Number.POSITIVE_INFINITY);
  if (!chosen) {
    await applyTriageAndContinue(db, current, {}, deps);
    return;
  }
  const { iteration, round, worker } = chosen;
  const rounds = iterations.length;
  const passed = iteration.id === last.id && last.outcome === "converged" && roundPassed(round);
  const questions: string[] = [];
  const notes: string[] = [];
  if (passed) {
    notes.push(
      needsCritique(round)
        ? `**Checks:** passed the work item lint and the plan critic in round ${rounds} of ${last.maxIterations - iterations[0]!.number + 1}`
        : "**Checks:** a Feature's recommendation isn't linted or critiqued",
    );
  } else {
    questions.push(...unresolvedQuestions(round, rounds));
    if (needsCritique(round) && !round.critique) {
      questions.push(
        uncritiquedQuestion(iteration.error ?? iteration.summary ?? "it didn't answer"),
      );
    }
    notes.push(
      `**Checks:** not passed after ${rounds} ${rounds === 1 ? "round" : "rounds"}; what's left is in the open questions`,
    );
  }
  await applyTriageAndContinue(
    db,
    current,
    { result: worker.result, openQuestions: questions, notes },
    deps,
  );
}

registerLoopAdapter("triage", triageLoopAdapter);
