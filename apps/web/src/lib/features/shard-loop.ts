import "server-only";
import { checkShard } from "@omniralph/planning";
import {
  getFeatureShard,
  getJob,
  getRepository,
  insertJob,
  listRunIterations,
  pinnedAgentFor,
  updateFeatureShard,
  updateRunIteration,
  type Database,
  type Feature,
  type FeatureShard,
  type FeatureShardDraft,
  type Job,
  type LoopRunRef,
  type RunIteration,
  type RunLoopOutcome,
} from "@omniralph/db";
import {
  QueryRunResult,
  RunSpecJobPayload,
  SHARD_PLAN_JOB_TYPE,
  SHARD_VERIFY_JOB_TYPE,
  ShardPlanOutput,
  ShardPlanTriggerContext,
  ShardRound,
  ShardVerifyOutput,
  sectionList,
  type ShardRevision,
  type ShardVerifyTriggerContext,
} from "@omniralph/shared";
import { syncJobsDueFromPostgres } from "@/lib/dispatch/due";
import { getPlaybookTask, organizationPlaybooks, taskJobInput } from "@/lib/playbooks";
import {
  registerLoopAdapter,
  startLoop,
  type LoopAdapter,
  type LoopEnd,
  type LoopExecutor,
  type LoopVerdict,
} from "@/lib/runs/loop";

/**
 * Sharding a feature's Plan as a loop (ADR 0013, run kind `shard`, `run_id` the
 * `feature_shards` row). Each round:
 *
 * 1. The worker is a `feature.shard-plan` job of `builtin:shard-plan` that drafts the epics,
 *    each with the Plan sections it covers and the epics it waits for; from the second round
 *    on it gets the previous usable draft and what the checks found (`revision`).
 * 2. The checks: Om's structural check (`checkShard`: every section covered or exempted,
 *    covers naming real sections, dependencies naming real epics without a cycle, each epic in
 *    the epic format), run here as the worker finishes, then the verifier, a
 *    `feature.verify-shard` job of the loop's verifier playbook (`builtin:verify-shard`) that
 *    judges coverage, invented scope and the dependencies. An unusable draft gets no verifier.
 * 3. Both passing ends the loop; otherwise what they found is the next round's revision,
 *    until the loop's cap (the playbook's `loop.maxIterations`).
 *
 * Each round is recorded on its iteration (`details`, a `ShardRound`). When the loop ends, the
 * last usable round's drafts wait on the sharding for a person's review (`review`), with the
 * verifier's notes on each and, unless that round passed both checks, what still failed
 * (`leftovers`); without any usable draft the sharding fails. Nothing is filed here.
 */

export const SHARD_PLAN_TASK_ID = "builtin:shard-plan";

/** The loop run of sharding `shard`. */
export function shardLoopRun(shard: Pick<FeatureShard, "id" | "organizationId">): LoopRunRef {
  return { kind: "shard", id: shard.id, organizationId: shard.organizationId };
}

/** The pool or a transaction as the `@omniralph/db` queries take it. */
function asDb(db: LoopExecutor): Database {
  return db as Database;
}

/** Longest feedback (the iteration's findings are limited by the driver too). */
const MAX_FINDINGS = 100;
const MAX_FINDING_LENGTH = 5_000;

/** The round's draft and Om's check of it, from a completed worker. */
export function workerRound(
  job: Pick<Job, "result">,
  sections: FeatureShard["sections"],
): ShardRound {
  const run = QueryRunResult.safeParse(job.result);
  const output =
    run.success && run.data.outcome === "answered"
      ? ShardPlanOutput.safeParse(run.data.structured)
      : null;
  if (!output?.success) {
    return {
      draft: null,
      check: {
        passed: false,
        problems: [
          run.success && run.data.outcome !== "answered"
            ? "The round didn't answer with a draft."
            : "The round's answer wasn't a draft of epics (`epics`, `exempt`, `summary`).",
        ],
      },
      verification: null,
    };
  }
  const problems = checkShard(sections, output.data);
  return {
    draft: output.data,
    check: { passed: problems.length === 0, problems },
    verification: null,
  };
}

/** Everything the round's checks found, one finding each (Om's check first). */
export function roundFindings(round: ShardRound): string[] {
  const findings = [...round.check.problems];
  const verification = round.verification;
  if (verification) {
    for (const { section, note } of verification.uncoveredSections) {
      findings.push(`No epic really covers the Plan's "${section}" section: ${note}`);
    }
    for (const { epic, scope } of verification.inventedScope) {
      findings.push(`Epic ${epic} adds scope the Plan lacks: ${scope}`);
    }
    findings.push(...verification.dependencyProblems);
    if (verification.verdict === "fail" && findings.length === 0) {
      for (const { epic, note } of verification.epicNotes) findings.push(`Epic ${epic}: ${note}`);
    }
  }
  return findings;
}

/** Whether both checks passed the round. */
export function roundPassed(round: ShardRound): boolean {
  return round.check.passed && round.verification?.verdict === "pass";
}

const clip = (text: string) =>
  text.length > MAX_FINDING_LENGTH ? `${text.slice(0, MAX_FINDING_LENGTH - 1)}…` : text;

function roundVerdict(round: ShardRound): LoopVerdict {
  const findings = roundFindings(round);
  const summary =
    round.verification?.summary ??
    (round.check.passed
      ? "Om's check passed the draft."
      : `Om's check found ${findings.length} ${findings.length === 1 ? "problem" : "problems"}.`);
  return {
    converged: roundPassed(round),
    summary: clip(summary),
    findings: findings.slice(0, MAX_FINDINGS).map(clip),
  };
}

/** The verdict of a round whose sharding ended meanwhile (discarded). */
const SHARD_OVER: LoopVerdict = {
  converged: true,
  summary: "The sharding was discarded meanwhile, so the loop stops.",
  findings: [],
};

/** The recorded round of `iteration`, or null. */
function readRound(details: unknown): ShardRound | null {
  const parsed = ShardRound.safeParse(details);
  return parsed.success ? parsed.data : null;
}

/** The newest round of `iterations` (before `number`) with a usable draft. */
function lastUsableRound(
  iterations: readonly RunIteration[],
  number = Number.POSITIVE_INFINITY,
): { iteration: RunIteration; round: ShardRound & { draft: ShardPlanOutput } } | null {
  for (const iteration of [...iterations].reverse()) {
    if (iteration.number >= number) continue;
    const round = readRound(iteration.details);
    if (round?.draft) return { iteration, round: { ...round, draft: round.draft } };
  }
  return null;
}

/** The sharding `run` still drafting, or null when it moved on. */
async function draftingShard(db: LoopExecutor, run: LoopRunRef): Promise<FeatureShard | null> {
  const shard = await getFeatureShard(asDb(db), run.organizationId, run.id);
  return shard?.status === "drafting" ? shard : null;
}

/** The repo the feature is scoped to, as a checkout: connected, with a known default branch. */
async function checkoutOf(
  db: Database,
  feature: Pick<Feature, "organizationId" | "repositoryId">,
): Promise<{ repositoryId: string; fullPath: string; ref: string } | null> {
  if (!feature.repositoryId) return null;
  const repository = await getRepository(db, feature.repositoryId, feature.organizationId);
  if (!repository || repository.disconnectedAt || !repository.defaultBranch) return null;
  return {
    repositoryId: repository.id,
    fullPath: repository.fullPath,
    ref: repository.defaultBranch,
  };
}

/**
 * Starts the loop of sharding `shard` of `feature`: its first round's worker job, over the
 * feature's PRFAQ (null without one) and Plan. Returns the worker job's ID.
 */
export async function startShardLoop(
  db: Database,
  shard: FeatureShard,
  feature: Pick<Feature, "name" | "organizationId" | "repositoryId">,
  documents: { prfaq: string | null; plan: string },
): Promise<string> {
  const definitions = organizationPlaybooks(db, shard.organizationId);
  const playbook = await definitions.getPlaybook(SHARD_PLAN_TASK_ID);
  const task = await getPlaybookTask(definitions, SHARD_PLAN_TASK_ID);
  if (!playbook || !task) throw new Error(`the built-in task ${SHARD_PLAN_TASK_ID} is missing`);
  const checkout = await checkoutOf(db, feature);
  const context: ShardPlanTriggerContext = {
    invoker: { kind: "feature-shard", id: shard.id },
    repository: checkout?.fullPath ?? null,
    shard: {
      feature: feature.name,
      prfaq: documents.prfaq?.trim() ? documents.prfaq : null,
      plan: documents.plan,
      sections: sectionList(shard.sections),
      previousDraft: null,
      revision: null,
    },
  };
  const jobInput = await taskJobInput(definitions, task, {
    trigger: { kind: "run.invoked", context },
    ...(checkout && { repositoryId: checkout.repositoryId, ref: checkout.ref }),
  });
  let jobId: string | undefined;
  const iteration = await startLoop(db, shardLoopRun(shard), playbook, {
    startWorker: async (tx, it) => {
      const { job } = await insertJob(asDb(tx), {
        organizationId: shard.organizationId,
        type: SHARD_PLAN_JOB_TYPE,
        ...jobInput,
        dedupeKey: `feature-shard:${shard.id}:${it.number}`,
        targetAgentId: checkout
          ? await pinnedAgentFor(asDb(tx), shard.organizationId, checkout.repositoryId)
          : null,
      });
      jobId = job.id;
      return job.id;
    },
  });
  if (!iteration) throw new Error(`${SHARD_PLAN_TASK_ID} names no verifier, so it can't loop`);
  return jobId ?? iteration.workerJobId!;
}

const shardLoopAdapter: LoopAdapter = {
  /** A round after the first: the first round's job again, with the last usable draft and the revision. */
  async startWorker(db, run, iteration) {
    const iterations = (await listRunIterations(db, run)).filter(
      (it) => it.number <= iteration.number,
    );
    const first = iterations[0]?.workerJobId
      ? await getJob(asDb(db), iterations[0].workerJobId)
      : null;
    if (!first) throw new Error(`Sharding ${run.id}'s loop has no first job`);
    const payload = RunSpecJobPayload.parse(first.payload);
    const context = ShardPlanTriggerContext.parse(payload.trigger.context);
    const previous = lastUsableRound(iterations, iteration.number);
    const revision: ShardRevision = {
      round: iteration.number,
      maxRounds: Math.max(iteration.maxIterations, iteration.number),
      feedback: iteration.feedback ?? "Revise the draft.",
    };
    const next: ShardPlanTriggerContext = {
      ...context,
      shard: {
        ...context.shard,
        previousDraft: previous
          ? JSON.stringify({
              epics: previous.round.draft.epics,
              exempt: previous.round.draft.exempt,
            })
          : null,
        revision,
      },
    };
    const { job } = await insertJob(asDb(db), {
      organizationId: first.organizationId,
      type: first.type,
      taskType: first.taskType,
      taskId: first.taskId,
      minAgentVersion: first.minAgentVersion,
      requiredInstallables: first.requiredInstallables,
      requiredHostTools: first.requiredHostTools,
      payload: { ...payload, trigger: { ...payload.trigger, context: next } },
      repositoryId: first.repositoryId,
      dedupeKey: `feature-shard:${run.id}:${iteration.number}`,
      targetAgentId: first.repositoryId
        ? await pinnedAgentFor(asDb(db), first.organizationId, first.repositoryId)
        : null,
    });
    return job.id;
  },

  /**
   * The round's checks: Om's check at once, recorded on the iteration, then the verifier (a
   * run of the loop's verifier playbook in a checkout of the worker's), unless the draft isn't
   * usable or there's no verifier that can run.
   */
  async startVerifier(db, run, iteration, worker) {
    const shard = await draftingShard(db, run);
    if (!shard) return { verdict: SHARD_OVER };
    const round = workerRound(worker, shard.sections);
    await updateRunIteration(asDb(db), iteration.id, { details: round });
    if (!round.draft) return { verdict: roundVerdict(round) };

    const definitions = organizationPlaybooks(asDb(db), run.organizationId);
    const task = await getPlaybookTask(definitions, iteration.verifierPlaybookId);
    if (!task || task.taskType !== "query" || !task.triggers.includes("run.invoked")) {
      return {
        verdict: {
          converged: true,
          summary: `${iteration.verifierPlaybookId} isn't a shard verifier that can run, so the draft wasn't verified.`,
          findings: [],
        },
      };
    }
    const payload = RunSpecJobPayload.parse(worker.payload);
    const worked = ShardPlanTriggerContext.parse(payload.trigger.context);
    const context: ShardVerifyTriggerContext = {
      invoker: { kind: "feature-shard", id: run.id },
      repository: worked.repository,
      shard: {
        feature: worked.shard.feature,
        plan: worked.shard.plan,
        sections: worked.shard.sections,
        round: iteration.number,
        draft: JSON.stringify(round.draft.epics),
        exempt: round.draft.exempt.length > 0 ? JSON.stringify(round.draft.exempt) : null,
        check: round.check.passed ? null : round.check.problems.map((p) => `- ${p}`).join("\n"),
      },
    };
    const { job } = await insertJob(asDb(db), {
      organizationId: run.organizationId,
      type: SHARD_VERIFY_JOB_TYPE,
      ...(await taskJobInput(definitions, task, {
        trigger: { kind: "run.invoked", context },
        ...(worker.repositoryId && payload.ref
          ? { repositoryId: worker.repositoryId, ref: payload.ref }
          : {}),
      })),
      dedupeKey: `feature-shard-verify:${run.id}:${iteration.number}`,
      targetAgentId: worker.repositoryId
        ? await pinnedAgentFor(asDb(db), run.organizationId, worker.repositoryId)
        : null,
    });
    return job.id;
  },

  /**
   * The round's verdict once the verifier answered, recorded with the round. A verifier that
   * didn't answer with a verdict stops the loop: its draft goes to review with that noted.
   */
  async judge(db, run, iteration, verifier) {
    if (!(await draftingShard(db, run))) return SHARD_OVER;
    const round = readRound(iteration.details);
    if (!round) return null;
    const result = QueryRunResult.safeParse(verifier.result);
    const output =
      result.success && result.data.outcome === "answered"
        ? ShardVerifyOutput.safeParse(result.data.structured)
        : null;
    if (!output?.success) {
      return {
        converged: true,
        summary: "The shard verifier didn't answer with a verdict, so the loop stops.",
        findings: [],
      };
    }
    const verified: ShardRound = { ...round, verification: output.data };
    await updateRunIteration(asDb(db), iteration.id, { details: verified });
    return roundVerdict(verified);
  },

  /** Puts the last usable round's drafts up for review, or fails the sharding without any. */
  async finish(db, run, end) {
    const shard = await getFeatureShard(asDb(db), run.organizationId, run.id, { lock: true });
    if (shard?.status !== "drafting") return;
    await updateFeatureShard(asDb(db), shard.id, reviewPatch(end), "drafting");
  },

  /** Makes the loop's new jobs claimable. */
  async afterCommit(db, run) {
    const last = (await listRunIterations(db, run)).at(-1);
    await syncJobsDueFromPostgres(
      db,
      [last?.workerJobId, last?.verifierJobId].filter((id): id is string => Boolean(id)),
    );
  },
};

/** What the loop's end makes of the sharding: its drafts for review, or why it failed. */
export function reviewPatch(end: LoopEnd): Parameters<typeof updateFeatureShard>[2] {
  const last = end.iterations.at(-1);
  const chosen = lastUsableRound(end.iterations);
  if (!chosen) {
    const round = last ? readRound(last.details) : null;
    return {
      status: "failed",
      outcome: end.outcome,
      error:
        last?.error ??
        round?.check.problems.join(" ") ??
        "Om couldn't draft any epics from the Plan.",
    };
  }
  const { iteration, round } = chosen;
  const passed = iteration.id === last?.id && end.outcome === "converged" && roundPassed(round);
  const leftovers = passed ? [] : roundFindings(round);
  if (!passed && !round.verification) {
    leftovers.push(
      `The verifier didn't check this draft (${(iteration.error ?? iteration.summary ?? "it didn't answer").replace(/\.$/, "")}): check its coverage and scope yourself.`,
    );
  }
  if (last && last.id !== iteration.id && last.error) {
    leftovers.push(
      `Round ${last.number} failed, so these are round ${iteration.number}'s drafts: ${last.error}`,
    );
  }
  return {
    status: "review",
    outcome: end.outcome as RunLoopOutcome,
    drafts: round.draft.epics.map((epic) => draftOf(epic, round)),
    exempt: round.draft.exempt,
    summary: round.verification?.summary ?? (round.draft.summary || null),
    leftovers,
    error: null,
  };
}

function draftOf(epic: ShardPlanOutput["epics"][number], round: ShardRound): FeatureShardDraft {
  const notes = [
    ...(round.verification?.epicNotes ?? [])
      .filter((note) => note.epic === epic.key)
      .map((note) => note.note),
    ...(round.verification?.inventedScope ?? [])
      .filter((scope) => scope.epic === epic.key)
      .map((scope) => `Adds scope the Plan lacks: ${scope.scope}`),
  ];
  return {
    key: epic.key,
    title: epic.title,
    description: epic.description,
    covers: [...epic.covers],
    dependsOn: [...epic.dependsOn],
    notes,
    decision: "pending",
    edited: false,
    filed: null,
  };
}

registerLoopAdapter("shard", shardLoopAdapter);
