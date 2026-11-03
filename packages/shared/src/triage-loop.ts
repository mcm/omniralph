/**
 * Triage as a loop (ADR 0013): each round, a `triage.run` worker drafts (or
 * revises) the work item, then two checks judge the draft: the work item lint
 * (`lintWorkItem` of `@omniralph/planning`, run by the control panel) and the
 * plan critic (`builtin:critique-plan`, a `triage.critique-plan` job). The lint
 * failures and the critic's unmet notes and questions are the next round's
 * feedback, until both pass or the loop's cap. Each round is recorded on its
 * `run_iterations` row (`details`) as a `TriageRound`.
 */
import { z } from "zod";
import { TriageRunInvoker } from "./correlation.js";
import { PLAN_CRITIQUE_VERDICTS, PlanCritiqueContext, PlanCritiqueNote } from "./plan-critique.js";
import { TRIAGE_OUTCOME_KINDS, TRIAGE_SIZES, TriageSizing } from "./triage-job.js";

/** Job type of a triage round's plan critique (a run of the loop's verifier playbook). */
export const TRIAGE_CRITIQUE_JOB_TYPE = "triage.critique-plan";

/**
 * The trigger context of a triage round's plan critique: the triage run that
 * invoked it, the repo the work item routes to (`owner/repo`, null without
 * one), the round, and the draft with its size (`planCritiqueContext`).
 */
export const TriageCritiqueTriggerContext = z.object({
  invoker: TriageRunInvoker,
  repository: z.string().nullable(),
  round: z.int().min(1),
  critique: PlanCritiqueContext,
});
export type TriageCritiqueTriggerContext = z.infer<typeof TriageCritiqueTriggerContext>;

/** A round's draft, as its worker reported it (validated). */
export const TriageRoundDraft = z.object({
  outcome: z.enum(TRIAGE_OUTCOME_KINDS),
  sizing: TriageSizing,
  size: z.enum(TRIAGE_SIZES),
  title: z.string(),
  description: z.string(),
  openQuestions: z.array(z.string()),
  /**
   * An epic's stories (or a reformat's sub-issue updates), in order, with what the plan critic
   * judges the epic's story order and split by: each one's kind, the 0-based indexes of the
   * stories it is blocked by and whether only a person can do it (rounds recorded before these
   * were kept read as a story with no blockers, for an agent).
   */
  stories: z.array(
    z.object({
      title: z.string(),
      body: z.string(),
      kind: z.enum(["story", "fix"]).default("story"),
      dependsOn: z.array(z.int().min(0)).default([]),
      manual: z.boolean().default(false),
    }),
  ),
});
export type TriageRoundDraft = z.infer<typeof TriageRoundDraft>;

/** The work item lint of a round's draft: every problem it found (empty when it passed). */
export const TriageRoundLint = z.object({
  passed: z.boolean(),
  problems: z.array(z.string()),
});
export type TriageRoundLint = z.infer<typeof TriageRoundLint>;

/** The plan critic's judgement of a round's draft. */
export const TriageRoundCritique = z.object({
  verdict: z.enum(PLAN_CRITIQUE_VERDICTS),
  notes: z.array(PlanCritiqueNote),
  openQuestions: z.array(z.string()),
});
export type TriageRoundCritique = z.infer<typeof TriageRoundCritique>;

/**
 * One round of a triage loop (`run_iterations.details`): its draft (null when
 * the worker's output wasn't a usable triage: the lint then holds why), the
 * lint result, and the critic's judgement (null while it runs, and for a draft
 * it doesn't judge: an unusable one, or a Feature's recommendation).
 */
export const TriageRound = z.object({
  draft: TriageRoundDraft.nullable(),
  lint: TriageRoundLint,
  critique: TriageRoundCritique.nullable(),
});
export type TriageRound = z.infer<typeof TriageRound>;

/**
 * What a triage round's worker is told to revise (its trigger context's
 * `revision`): the round, the loop's cap and the checks' feedback on the
 * previous round's draft.
 */
export const TriageRevision = z.object({
  round: z.int().min(2),
  maxRounds: z.int().min(2),
  feedback: z.string().min(1),
});
export type TriageRevision = z.infer<typeof TriageRevision>;
