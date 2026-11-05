/**
 * Sharding a feature's Plan into epics, as a loop (ADR 0013, run kind `shard`): each round a
 * `feature.shard-plan` worker (`builtin:shard-plan`) drafts the epics, each with the Plan
 * sections it covers and the epics it waits for; Om checks the draft's structure
 * (`checkShard` of `@omniralph/planning`), then a `feature.verify-shard` verifier
 * (`builtin:verify-shard`, role `verifier`) judges its coverage and scope. What they find is
 * the next round's revision, until both pass or the loop's cap. Each round is recorded on its
 * `run_iterations` row (`details`) as a `ShardRound`; the drafts then wait for a person's
 * review before anything is filed.
 */
import { z } from "zod";
import { FeatureShardInvoker } from "./correlation.js";

/** Job type of a sharding round's worker (a run of `builtin:shard-plan`). */
export const SHARD_PLAN_JOB_TYPE = "feature.shard-plan";
/** Job type of a sharding round's verifier (a run of the loop's verifier playbook). */
export const SHARD_VERIFY_JOB_TYPE = "feature.verify-shard";

/** Most epics a draft may have. */
export const MAX_SHARD_EPICS = 30;
/** Longest epic key (`E1`). */
export const MAX_SHARD_KEY_LENGTH = 40;
/** Longest epic title. */
export const MAX_SHARD_TITLE_LENGTH = 255;
/** Longest epic description. */
export const MAX_SHARD_DESCRIPTION_LENGTH = 50_000;
/** Longest Plan section name a draft may name. */
export const MAX_SHARD_SECTION_LENGTH = 300;
/** Most sections an epic may cover (or a draft exempt). */
export const MAX_SHARD_SECTIONS = 100;
/** Longest note (a verifier note, a reason, a summary). */
export const MAX_SHARD_NOTE_LENGTH = 5_000;

const key = z.string().trim().min(1).max(MAX_SHARD_KEY_LENGTH);
const section = z.string().trim().min(1).max(MAX_SHARD_SECTION_LENGTH);
const note = z.string().trim().min(1).max(MAX_SHARD_NOTE_LENGTH);

/** One epic of a sharding draft. */
export const ShardEpicDraft = z.object({
  /** Its short key in the draft (`E1`), which other epics' `dependsOn` name. */
  key,
  title: z.string().trim().min(1).max(MAX_SHARD_TITLE_LENGTH),
  /** The epic in the epic format (Problem, Scope, Design, Technical notes, Requirements). */
  description: z.string().trim().min(1).max(MAX_SHARD_DESCRIPTION_LENGTH),
  /** The names of the Plan sections it builds. */
  covers: z.array(section).max(MAX_SHARD_SECTIONS),
  /** The keys of the epics it waits for: each becomes an epic→epic blocks relation. */
  dependsOn: z.array(key).max(MAX_SHARD_EPICS),
});
export type ShardEpicDraft = z.infer<typeof ShardEpicDraft>;

/** A Plan section the draft says needs no epic (its context, what it leaves out), and why. */
export const ShardExemption = z.object({ section, reason: note });
export type ShardExemption = z.infer<typeof ShardExemption>;

/** The structured output of `builtin:shard-plan`: the draft. */
export const ShardPlanOutput = z.object({
  epics: z.array(ShardEpicDraft).min(1).max(MAX_SHARD_EPICS),
  exempt: z.array(ShardExemption).max(MAX_SHARD_SECTIONS).default([]),
  summary: z.string().trim().max(MAX_SHARD_NOTE_LENGTH).default(""),
});
export type ShardPlanOutput = z.infer<typeof ShardPlanOutput>;

export const SHARD_VERIFY_VERDICTS = ["pass", "fail"] as const;
export type ShardVerifyVerdict = (typeof SHARD_VERIFY_VERDICTS)[number];

/**
 * The structured output of `builtin:verify-shard`: the sections no epic really covers, the
 * scope epics add that the Plan lacks, the dependency problems, a note per epic and a summary.
 * A `pass` has none of the first three.
 */
export const ShardVerifyOutput = z
  .object({
    verdict: z.enum(SHARD_VERIFY_VERDICTS),
    uncoveredSections: z.array(z.object({ section, note })).max(MAX_SHARD_SECTIONS),
    inventedScope: z.array(z.object({ epic: key, scope: note })).max(MAX_SHARD_SECTIONS),
    dependencyProblems: z.array(note).max(MAX_SHARD_SECTIONS),
    epicNotes: z.array(z.object({ epic: key, note })).max(MAX_SHARD_EPICS),
    summary: note,
  })
  .superRefine((output, ctx) => {
    if (output.verdict !== "pass") return;
    if (
      output.uncoveredSections.length > 0 ||
      output.inventedScope.length > 0 ||
      output.dependencyProblems.length > 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "A pass leaves no section uncovered, no invented scope and no dependency problem.",
      });
    }
  });
export type ShardVerifyOutput = z.infer<typeof ShardVerifyOutput>;

/** Om's structural check of a round's draft (`checkShard`): every problem (empty when it passed). */
export const ShardRoundCheck = z.object({
  passed: z.boolean(),
  problems: z.array(z.string()),
});
export type ShardRoundCheck = z.infer<typeof ShardRoundCheck>;

/**
 * One round of a sharding loop (`run_iterations.details`): its draft (null when the worker's
 * output wasn't a usable draft: the check then holds why), Om's structural check, and the
 * verifier's judgement (null while it runs, and for an unusable draft).
 */
export const ShardRound = z.object({
  draft: ShardPlanOutput.nullable(),
  check: ShardRoundCheck,
  verification: ShardVerifyOutput.nullable(),
});
export type ShardRound = z.infer<typeof ShardRound>;

/** The round's revision, from the second round on. */
export const ShardRevision = z.object({
  round: z.int().min(2),
  maxRounds: z.int().min(2),
  feedback: z.string(),
});
export type ShardRevision = z.infer<typeof ShardRevision>;

/**
 * The trigger context of a sharding round's worker: the feature, its PRFAQ and Plan, the
 * Plan's sections as a list, the repo it is scoped to (checked out read-only when it has a
 * default branch), and from the second round on the previous draft (JSON) and the revision.
 */
export const ShardPlanTriggerContext = z.object({
  invoker: FeatureShardInvoker,
  repository: z.string().nullable(),
  shard: z.object({
    feature: z.string(),
    prfaq: z.string().nullable(),
    plan: z.string(),
    sections: z.string(),
    previousDraft: z.string().nullable(),
    revision: ShardRevision.nullable(),
  }),
});
export type ShardPlanTriggerContext = z.infer<typeof ShardPlanTriggerContext>;

/**
 * The trigger context of a sharding round's verifier: the feature, its Plan and sections, the
 * round, the draft's epics and exemptions (JSON) and Om's structural problems (null when none).
 */
export const ShardVerifyTriggerContext = z.object({
  invoker: FeatureShardInvoker,
  repository: z.string().nullable(),
  shard: z.object({
    feature: z.string(),
    plan: z.string(),
    sections: z.string(),
    round: z.int().min(1),
    draft: z.string(),
    exempt: z.string().nullable(),
    check: z.string().nullable(),
  }),
});
export type ShardVerifyTriggerContext = z.infer<typeof ShardVerifyTriggerContext>;

/** Sections as the prompts list them: one `- ` line each. */
export function sectionList(sections: readonly { name: string }[]): string {
  return sections.map((s) => `- ${s.name.replace(/\s+/g, " ").trim()}`).join("\n");
}
