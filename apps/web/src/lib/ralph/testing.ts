/**
 * Helpers for ralph tests: coding playbooks with their own coding settings, and an
 * accepting task verifier.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  claimJob,
  completeJob,
  getJob,
  insertPlaybook,
  jobs,
  repositories,
  type Database,
  type Job,
} from "@omniralph/db";
import {
  MAX_JOB_DELIVERIES,
  RALPH_VERIFY_TASK_JOB_TYPE,
  RalphVerifyTaskTriggerContext,
  RunSpecJobPayload,
} from "@omniralph/shared";
import { getBuiltinPlaybook, type Playbook, type PlaybookCoding } from "@omniralph/tasks";
import { onRalphJobFinished, onRalphJobStarted } from "./jobs";
import type { RalphDeps } from "./run";

/**
 * Binds `repositoryId` to a copy of its built-in story (or request) playbook with `coding`
 * settings (and any other `fields`, e.g. its model), stored for the organization; returns the
 * playbook's ID.
 */
export async function bindCodingPlaybook(
  db: Database,
  organizationId: string,
  repositoryId: string,
  role: "story" | "request",
  coding: PlaybookCoding,
  fields: Partial<Pick<Playbook, "model" | "fallbackModel">> = {},
): Promise<string> {
  const builtin = role === "story" ? "builtin:implement-story" : "builtin:handle-request";
  const { id: _id, name, role: _role, ...definition } = getBuiltinPlaybook(builtin)!;
  const row = await insertPlaybook(db, organizationId, {
    name: `${name} (test)`,
    role,
    definition: { ...definition, ...fields, coding: { ...definition.coding, ...coding } },
    requirements: {},
    createdBy: null,
  });
  await db
    .update(repositories)
    .set(role === "story" ? { storyPlaybookId: row.id } : { requestPlaybookId: row.id })
    .where(eq(repositories.id, repositoryId));
  return row.id;
}

/** Binds `repositoryId` back to the built-in story and request playbooks. */
export async function bindBuiltinPlaybooks(db: Database, repositoryId: string): Promise<void> {
  await db
    .update(repositories)
    .set({
      storyPlaybookId: "builtin:implement-story",
      requestPlaybookId: "builtin:handle-request",
    })
    .where(eq(repositories.id, repositoryId));
}

/**
 * Plays the agent's part for a run's queued task verifier, if one is queued: a
 * `ralph.verify-task` query run that accepts every criterion it was given. Ralph tests
 * that aren't about verification call it after a story job finishes, so a completed
 * attempt counts as it did before verification.
 */
export async function acceptTaskVerifier(
  db: Database,
  deps: RalphDeps,
  runId: string,
  agentId: string,
): Promise<Job | null> {
  const [job] = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.ralphRunId, runId),
        eq(jobs.type, RALPH_VERIFY_TASK_JOB_TYPE),
        inArray(jobs.status, ["queued", "running"]),
      ),
    );
  if (!job) return null;
  const by = job.targetAgentId ?? agentId;
  const { claim } = await claimJob(db, {
    organizationId: job.organizationId,
    agentId: by,
    acceptedTaskTypes: ["query", "coding"],
    pools: ["short", "long"],
    agentVersion: "99.0.0",
    maxDeliveries: MAX_JOB_DELIVERIES,
  });
  if (claim?.job.id !== job.id) throw new Error(`expected to claim task verifier ${job.id}`);
  await onRalphJobStarted(db, job, by);
  const { payload } = RalphVerifyTaskTriggerContext.parse(
    RunSpecJobPayload.parse(job.payload).trigger.context,
  );
  const given = payload.story.acceptanceCriteria;
  const criteria = (given.length > 0 ? given : ["The change does what the task describes"]).map(
    (criterion) => ({ criterion, accepted: true, reason: "Shown by the change." }),
  );
  await completeJob(db, {
    jobId: job.id,
    agentId: by,
    result: {
      outcome: "answered",
      answer: null,
      structured: { criteria, summary: "Every criterion holds." },
      references: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
    },
  });
  await onRalphJobFinished(db, (await getJob(db, job.id))!, deps);
  return job;
}
