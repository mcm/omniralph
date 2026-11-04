/**
 * Structured results of ralph's Claude sessions: the zod schemas, the JSON schemas passed to the
 * Agent SDK as `outputFormat`, and readers that validate and normalise a session's result.
 */
import {
  type LintCode,
  type WorkItemFormat,
  type WorkItemKind,
  lintWorkItem,
  VALIDATION_AUDIT_TITLE,
  workItemFormat,
} from "@omniralph/planning";
import { z } from "zod";
import { parsePrd } from "./prd.js";
import { PR_TITLE_MAX_LENGTH } from "./prompt.js";
import { hasOpenQuestionsHeading } from "./triage.js";

/** At most this many follow-up issues are filed from one story session. */
export const MAX_FOLLOW_UPS = 10;

export interface FollowUp {
  title: string;
  description: string;
  /** Work for a person: filed with the manual label so no agent attempts it. */
  manual?: boolean;
  /**
   * `epic`: the work depends on the epic being merged, so it can't be part of the epic. Filed as a
   * standalone task blocked by the epic, never blocking a story.
   */
  after?: "epic";
  /** Why it has to wait for the epic (with `after: "epic"`). */
  reason?: string;
}

/** At most this many `blockedBy` identifiers are kept from one story session (`MAX_RALPH_BLOCKED_BY` in `@omniralph/shared`). */
export const MAX_BLOCKED_BY = 10;

/** At most this many recommendations are kept from one story session (`MAX_RALPH_RESULT_RECOMMENDATIONS` in `@omniralph/shared`). */
export const MAX_RECOMMENDATIONS = 10;

/**
 * Advice for outside this project (e.g. an upstream fix that would let a workaround go): shown, never
 * filed as an issue, and it doesn't hold the story up.
 */
export interface Recommendation {
  title: string;
  description: string;
}

/** A JSON schema for `outputFormat`, from a zod schema. */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/** Why a structured result doesn't match its schema (or that there was none). */
function problemWith(error: z.ZodError | undefined): string {
  if (!error) return "no structured result";
  const issue = error.issues[0];
  return `invalid structured result: ${issue?.path.length ? `\`${issue.path.join(".")}\` ` : ""}${issue?.message ?? "doesn't match the schema"}`;
}

/** The structured result a story session must end with: it decides the story's outcome. */
export const StoryAgentOutput = z.object({
  status: z
    .enum(["complete", "blocked", "incomplete", "waiting"])
    .describe(
      "complete: every acceptance criterion is met. blocked: a retry can't get past an obstacle. incomplete: unfinished; try again. waiting: you are ending your turn to wait for background work you started; you are resumed when it finishes.",
    ),
  summary: z
    .string()
    .describe(
      "Posted to the tracker: what you did, or precisely what is in the way and what would unblock it.",
    ),
  commit: z
    .object({
      summary: z.string().describe("One line describing the work in progress worth keeping."),
    })
    .optional()
    .describe("Blocked only: commit the work so far (if the checks pass) instead of stashing it."),
  appliedStashes: z
    .array(z.string())
    .optional()
    .describe("SHAs of the offered stash entries you applied with `git stash apply`."),
  followUps: z
    .array(
      z.object({
        title: z.string().describe("Short imperative title."),
        description: z
          .string()
          .describe(
            "What is wrong, where, and what done looks like (acceptance criteria as `- [ ]` checkboxes).",
          ),
        manual: z
          .boolean()
          .describe("True for work only a person can do (access, outside settings, a decision)."),
        after: z
          .enum(["epic"])
          .optional()
          .describe(
            "`epic` when the work depends on this epic being merged, so it can't be part of the epic: it is filed as a standalone task that follows the epic instead of blocking anything. Leave it out otherwise.",
          ),
        reason: z
          .string()
          .optional()
          .describe('With `after: "epic"`: why the work can only happen once the epic ships.'),
      }),
    )
    .describe(
      "Work outside this story's scope, in this project, for the orchestrator to file as new stories. Never work for another project or repository. Empty when there is none.",
    ),
  blockedBy: z
    .array(z.string())
    .optional()
    .describe(
      'Only with `status: "blocked"`: the tracker identifiers (e.g. `ENG-123`) of other unfinished work you discovered, while working, that this story needs first. Never ask for another branch to be merged instead.',
    ),
  recommendations: z
    .array(
      z.object({
        title: z.string().describe("Short imperative title."),
        description: z
          .string()
          .describe(
            "Which project or repository, what to change there, and what it would let this one drop (e.g. a workaround).",
          ),
      }),
    )
    .optional()
    .describe(
      "Advice for another project or repository (e.g. an upstream fix that would let a workaround go). Shown to people, never filed as issues, and it doesn't hold this story up.",
    ),
  metric: z
    .object({
      name: z.string().describe("What is measured, e.g. `critique score`."),
      value: z.number().describe("This round's value."),
      direction: z
        .enum(["higher", "lower"])
        .describe("Whether a higher or a lower value is better."),
      target: z.number().optional().describe("The value the story aims for, if it has one."),
    })
    .optional()
    .describe(
      "Only when the story measures its progress across rounds (e.g. a review loop that files fixes and runs again): this round's value. A loop whose best value stops improving is set aside.",
    ),
});
export type StoryAgentOutput = z.infer<typeof StoryAgentOutput>;

/** Whether a story session's structured result says it waits for background work. */
export function isWaitingStory(structured: unknown): boolean {
  return (structured as { status?: unknown } | null | undefined)?.status === "waiting";
}

/** A story session's result after `readStoryOutcome`'s clean-up. */
export type StoryOutcome = Omit<StoryAgentOutput, "followUps" | "recommendations" | "blockedBy"> & {
  followUps: FollowUp[];
  recommendations?: Recommendation[];
  /** Trimmed, de-duplicated case-insensitively and capped; absent when empty. */
  blockedBy?: string[];
};

/** `outputFormat` schema of a story session. */
export const STORY_OUTPUT_SCHEMA = jsonSchema(StoryAgentOutput);

/**
 * A story session's structured result, with follow-ups and recommendations trimmed, deduplicated by title
 * and capped, and `blockedBy` trimmed, deduplicated case-insensitively and capped. A result
 * that is missing or doesn't match the schema gives the problem instead.
 */
export function readStoryOutcome(
  structured: unknown,
): { outcome: StoryOutcome } | { problem: string } {
  const parsed = structured === undefined ? undefined : StoryAgentOutput.safeParse(structured);
  if (!parsed?.success) return { problem: problemWith(parsed?.error) };
  const followUps: FollowUp[] = [];
  for (const f of parsed.data.followUps) {
    const title = f.title.replace(/\s+/g, " ").trim();
    if (!title || followUps.some((x) => x.title.toLowerCase() === title.toLowerCase())) continue;
    const reason = f.reason?.trim();
    followUps.push({
      title,
      description: f.description.trim(),
      ...(f.manual && { manual: true }),
      ...(f.after === "epic" && { after: "epic" as const, ...(reason && { reason }) }),
    });
  }
  const recommendations: Recommendation[] = [];
  for (const r of parsed.data.recommendations ?? []) {
    const title = r.title.replace(/\s+/g, " ").trim();
    if (!title || recommendations.some((x) => x.title.toLowerCase() === title.toLowerCase())) {
      continue;
    }
    recommendations.push({ title, description: r.description.trim() });
  }
  const blockedBy: string[] = [];
  for (const raw of parsed.data.blockedBy ?? []) {
    const id = raw.trim();
    if (!id || blockedBy.some((x) => x.toLowerCase() === id.toLowerCase())) continue;
    blockedBy.push(id);
  }
  const commit = parsed.data.commit?.summary.trim()
    ? { summary: parsed.data.commit.summary.replace(/\s+/g, " ").trim() }
    : undefined;
  // A metric without a name or a finite value is dropped, not an invalid result.
  const { metric: reported, recommendations: _, blockedBy: __, ...rest } = parsed.data;
  const name = reported?.name.replace(/\s+/g, " ").trim().slice(0, 200);
  const metric =
    reported && name && Number.isFinite(reported.value)
      ? {
          name,
          value: reported.value,
          direction: reported.direction,
          ...(reported.target !== undefined &&
            Number.isFinite(reported.target) && { target: reported.target }),
        }
      : undefined;
  return {
    outcome: {
      ...rest,
      commit,
      followUps: followUps.slice(0, MAX_FOLLOW_UPS),
      ...(recommendations.length > 0 && {
        recommendations: recommendations.slice(0, MAX_RECOMMENDATIONS),
      }),
      ...(blockedBy.length > 0 && { blockedBy: blockedBy.slice(0, MAX_BLOCKED_BY) }),
      ...(metric && { metric }),
    },
  };
}

/** The structured result of the session that writes a PR/MR title and description. */
export const DescribePrAgentOutput = z.object({
  title: z.string().describe("One line, imperative mood, at most ~70 characters."),
  body: z.string().describe("The markdown description."),
});
export type DescribePrAgentOutput = z.infer<typeof DescribePrAgentOutput>;

/** `outputFormat` schema of the session that writes a PR/MR title and description. */
export const PR_DESCRIPTION_SCHEMA = jsonSchema(DescribePrAgentOutput);

/** The title and description from a describe session's structured result, if it produced both. */
export function readPullRequestDescription(
  structured: unknown,
): { title: string; body: string } | undefined {
  const parsed = DescribePrAgentOutput.safeParse(structured);
  if (!parsed.success) return undefined;
  const title = parsed.data.title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");
  const body = parsed.data.body.trim();
  return title && body ? { title: title.slice(0, 200), body } : undefined;
}

/** The structured result a request session ends with (cyralph's `RequestResultSchema`). */
export const RequestAgentOutput = z.object({
  summary: z
    .string()
    .describe(
      "Posted to the tracker thread: what you did, with links (e.g. the pull/merge request URL).",
    ),
  pullRequest: z
    .object({
      action: z
        .enum(["open", "update", "ready"])
        .describe(
          "open: open the branch's pull/merge request as a draft. update: change the title/body of the open one. ready: mark it ready for review.",
        ),
      title: z.string().optional().describe("One line, at most ~70 characters (open, update)."),
      body: z.string().optional().describe("The markdown description (open, update)."),
    })
    .optional()
    .describe(
      "A change to the branch's pull/merge request for the orchestrator to make; push the branch first.",
    ),
  findings: z
    .array(
      z.object({
        id: z.string().describe("The finding's ID, as given in the request."),
        outcome: z
          .enum(["fixed", "skipped"])
          .describe("fixed: you changed the code for it. skipped: it's wrong or not worth it."),
        comment: z
          .string()
          .describe(
            "Posted in the finding's thread: one or two sentences on the change, or on why you skipped it.",
          ),
      }),
    )
    .optional()
    .describe(
      "What you did with each review finding the request lists by ID. Omniralph replies in the threads and resolves the fixed ones.",
    ),
  waiting: z
    .boolean()
    .optional()
    .describe(
      "True only when you are ending your turn to wait for background work you started; you are resumed when it finishes.",
    ),
  commit: z
    .object({
      message: z
        .string()
        .describe(
          "The commit message: a one-line subject (imperative mood, at most ~72 characters), a blank line, then a short body saying what changed and why.",
        ),
    })
    .optional()
    .describe(
      "Only when shipping (`/ship`): the message the orchestrator commits the worktree's changes with before it pushes the branch.",
    ),
});
export type RequestAgentOutput = z.infer<typeof RequestAgentOutput>;

/** Whether a request session's structured result says it waits for background work. */
export function isWaitingRequest(structured: unknown): boolean {
  return (structured as { waiting?: unknown } | null | undefined)?.waiting === true;
}

/** `outputFormat` schema of a request session. */
export const REQUEST_OUTPUT_SCHEMA = jsonSchema(RequestAgentOutput);

/** The most finding outcomes kept from one request session. */
export const MAX_FINDING_OUTCOMES = 50;
/** The longest finding comment kept. */
export const MAX_FINDING_COMMENT = 2000;

const FindingId = z.uuid();

/**
 * A request session's result (summary trimmed), or the problem with it. Finding outcomes
 * without a comment or a finding ID are dropped, and only the first per finding is kept.
 */
export function readRequestResult(
  structured: unknown,
): { result: RequestAgentOutput } | { problem: string } {
  const parsed = structured === undefined ? undefined : RequestAgentOutput.safeParse(structured);
  if (!parsed?.success) return { problem: problemWith(parsed?.error) };
  const { pullRequest } = parsed.data;
  const message = parsed.data.commit?.message.trim();
  const title = pullRequest?.title?.replace(/\s+/g, " ").trim();
  const body = pullRequest?.body?.trim();
  const findings: NonNullable<RequestAgentOutput["findings"]> = [];
  for (const f of parsed.data.findings ?? []) {
    const id = f.id.trim().toLowerCase();
    const comment = f.comment.trim();
    if (!comment || !FindingId.safeParse(id).success || findings.some((x) => x.id === id)) continue;
    findings.push({ id, outcome: f.outcome, comment: comment.slice(0, MAX_FINDING_COMMENT) });
  }
  return {
    result: {
      summary: parsed.data.summary.trim(),
      ...(pullRequest && {
        pullRequest: { action: pullRequest.action, ...(title && { title }), ...(body && { body }) },
      }),
      ...(findings.length > 0 && { findings: findings.slice(0, MAX_FINDING_OUTCOMES) }),
      ...(message && { commit: { message } }),
    },
  };
}

/** The t-shirt sizes of a triage: L and larger are an epic or a feature, smaller a single task. */
export const TRIAGE_OUTPUT_SIZES = ["XS", "S", "M", "L", "XL"] as const;
const LARGE_SIZES = new Set<string>(["L", "XL"]);

/**
 * What triage sizes the work as (`TRIAGE_WORK_SIZES` of `@omniralph/shared`): a Fix or a Story is
 * a single task, an Epic a set of tasks filed as sub-issues, a Feature a set of epics to plan as a
 * feature (nothing is filed).
 */
export const TRIAGE_WORK_SIZES = ["fix", "story", "epic", "feature"] as const;
export type TriageWorkSize = (typeof TRIAGE_WORK_SIZES)[number];

const TrackerPriority = z
  .literal([1, 2, 3, 4])
  .describe("Priority: 1 Urgent, 2 High, 3 Medium, 4 Low.");

/** The kind of a triaged task: a Fix is created with the integration's fix (bug) label. */
export const TRIAGE_TASK_KINDS = ["story", "fix"] as const satisfies readonly WorkItemKind[];

/** The structured result a triage session ends with (the shared `TriageOutcome` plus a summary). */
export const TriageAgentOutput = z.object({
  outcome: z
    .enum(["prd", "reformat", "unchanged"])
    .describe(
      "prd: the issue (with no sub-issues) is rewritten as an epic, a story or a fix. reformat: an issue already planned with sub-issues is put into the epic format, sub-issues included. unchanged: it already is in the formats. Always unchanged for a feature: the issue is left as it is.",
    ),
  sizing: z
    .object({
      size: z
        .enum(TRIAGE_WORK_SIZES)
        .describe(
          "fix: a single task fixing a bug. story: a single task of new work. epic: a set of tasks shipped in one pull request. feature: a set of epics, to plan as a feature instead.",
        ),
      reason: z.string().describe("One paragraph on why the work is this size."),
    })
    .describe("How big the work is, which decides the shape of the result, and why."),
  title: z.string().describe("The issue's title: descriptive but concise."),
  description: z
    .string()
    .describe(
      "The issue's new description in markdown, without a `## Open Questions` section: a task of three paragraphs for a fix or a story, the epic format for an epic. For a feature, the recommendation to plan it as a feature (why, and how to approach it), posted as a comment: the issue's description is left as it is.",
    ),
  size: z
    .enum(TRIAGE_OUTPUT_SIZES)
    .describe(
      "T-shirt size of the whole body of work: XS, S or M for a fix or a story, L or XL for an epic or a feature.",
    ),
  openQuestions: z
    .array(z.string())
    .describe("Every ambiguity you couldn't resolve, one question each. Empty when none remain."),
  stories: z
    .array(
      z.object({
        title: z.string().describe("The plain story title, without IDs."),
        body: z
          .string()
          .describe(
            'The task in three paragraphs: "I want you to …", "Build it by …" and "Don\'t stop until …". No IDs or metadata.',
          ),
        kind: z
          .enum(TRIAGE_TASK_KINDS)
          .default("story")
          .describe("fix for a task fixing a bug (created with the bug label), else story."),
        priority: TrackerPriority,
        dependsOn: z
          .array(z.number())
          .describe("0-based indexes, in `stories`, of the stories this one is blocked by."),
        manual: z.boolean().describe("True for a step only a person can do."),
      }),
    )
    .describe(
      "Epics with outcome prd only: the tasks to create as sub-issues, in order, with no validation task (Omniralph audits the epic before its pull request). Empty otherwise.",
    ),
  subIssueUpdates: z
    .array(
      z.object({
        id: z.string().describe("The existing sub-issue's id, as given in the prompt."),
        title: z.string().describe("The plain story title, without IDs."),
        body: z
          .string()
          .describe(
            'The task in three paragraphs: "I want you to …", "Build it by …" and "Don\'t stop until …".',
          ),
        priority: TrackerPriority,
        blockedBy: z
          .array(z.string())
          .describe(
            "Ids of the sibling sub-issues, and identifiers of work items outside the issue, it is blocked by.",
          ),
      }),
    )
    .describe(
      "outcome reformat only: Backlog/Todo sub-issues rewritten as three-paragraph tasks. Empty otherwise.",
    ),
  bug: z
    .object({
      locations: z
        .array(
          z.object({
            file: z.string().describe("The file's path in the repo, as you read it."),
            symbol: z
              .string()
              .describe(
                "The function, method, component or other symbol in the file where the bug likely lives; empty when it is the file as a whole.",
              ),
          }),
        )
        .describe(
          "Where the likely cause lives, by file and function you read in the repo. Empty when you couldn't locate it: never guess.",
        ),
      reproduction: z
        .array(z.string())
        .describe("The steps, input or state that make the bug happen, in order."),
      currentBehavior: z.string().describe("What happens now."),
      expectedBehavior: z.string().describe("What should happen instead."),
      unlocatedQuestion: z
        .string()
        .describe(
          "With no `locations`: the open question that would locate the cause (Omniralph adds it to the open questions). Empty when the cause is located.",
        ),
    })
    .nullable()
    .describe(
      "Fixes only: the bug triage (where the likely cause lives, how to reproduce it, what happens now and what should happen). Null for every other size.",
    ),
  featureEpics: z
    .array(
      z.object({
        title: z.string().describe("The plain epic title, without IDs."),
        summary: z.string().describe("What the epic delivers, in a sentence or two."),
      }),
    )
    .describe(
      "Features only: a first cut of the epics to plan the feature as, in order. Nothing is filed: they are posted with the recommendation. Empty otherwise.",
    ),
  summary: z
    .string()
    .describe(
      "Posted to the tracker thread: the outcome, the size and why, the structure, and how many open questions remain.",
    ),
});
export type TriageAgentOutput = z.infer<typeof TriageAgentOutput>;

/** A Fix's bug triage, as `validateTriageOutput` keeps it. */
export type TriageBugResult = Omit<NonNullable<TriageAgentOutput["bug"]>, "unlocatedQuestion">;

/**
 * The open question a Fix whose cause triage couldn't locate gets when the session didn't word
 * one (`bug.unlocatedQuestion`).
 */
export const UNLOCATED_BUG_QUESTION =
  "Triage couldn't locate the cause of this bug in the repo. Where does it happen (the file, function or screen), and what does it take to reproduce it?";

/**
 * A Fix's bug triage, trimmed (blank steps dropped, duplicate locations dropped), plus the open
 * question to add when the cause isn't located, or the problem with it.
 */
function readBugTriage(
  bug: NonNullable<TriageAgentOutput["bug"]>,
): { bug: TriageBugResult; question: string | null } | { problem: string } {
  const currentBehavior = bug.currentBehavior.trim();
  const expectedBehavior = bug.expectedBehavior.trim();
  const reproduction = bug.reproduction.map((step) => step.trim()).filter(Boolean);
  if (!currentBehavior) return { problem: "the bug triage doesn't say what happens now" };
  if (!expectedBehavior) return { problem: "the bug triage doesn't say what should happen" };
  if (reproduction.length === 0) return { problem: "the bug triage has no reproduction steps" };
  const locations: TriageBugResult["locations"] = [];
  for (const location of bug.locations) {
    const file = location.file.trim();
    const symbol = location.symbol.trim();
    if (!file) return { problem: "a location of the bug has no file" };
    if (!locations.some((l) => l.file === file && l.symbol === symbol)) {
      locations.push({ file, symbol });
    }
  }
  const question =
    locations.length > 0 ? null : bug.unlocatedQuestion.trim() || UNLOCATED_BUG_QUESTION;
  return { bug: { locations, reproduction, currentBehavior, expectedBehavior }, question };
}

/** A validated triage (`validateTriageOutput`): the result plus the kind its sizing gives a single task. */
export type TriageResult = Omit<TriageAgentOutput, "bug"> & {
  /** A Fix's bug triage; null for every other size. */
  bug: TriageBugResult | null;
  /** `fix` for a Fix (it gets the integration's fix label), else `story`. */
  kind: (typeof TRIAGE_TASK_KINDS)[number];
};

/** `outputFormat` schema of a triage session. */
export const TRIAGE_OUTPUT_SCHEMA = jsonSchema(TriageAgentOutput);

/** Longest issue title kept (the tracker's limit). */
export const MAX_TRIAGE_TITLE = 255;

function oneLine(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, MAX_TRIAGE_TITLE).trim();
}

/** Sections only legacy PRDs have: the repo decides the checks, and outcomes stay in planning documents. */
const LEGACY_ONLY_SECTION = /^##[ \t]+(Success Metrics|Quality Gates)[ \t]*$/im;
/**
 * The title of a validation task, such as a legacy epic's \`Validate functional requirements\`
 * sub-issue: a reformat may rewrite one without putting it in the task format.
 */
const VALIDATION_TITLE = /^validate\b/i;

/**
 * Whether a planned story is the legacy validation task. Triage no longer plans one (the epic
 * audit checks the requirements before the pull request opens), so one returned anyway is dropped.
 */
function isLegacyValidationTask(title: string): boolean {
  return title.toLowerCase() === VALIDATION_AUDIT_TITLE.toLowerCase();
}

/** The `## Success Metrics` or `## Quality Gates` heading `text` has, if any. */
function legacyOnlySection(text: string): string | null {
  const match = LEGACY_ONLY_SECTION.exec(text);
  return match ? `## ${match[1]}` : null;
}

const FORMAT_NAMES: Record<WorkItemFormat, string> = {
  epic: "the epic format (`## Problem`, `## Scope`, `## Requirements`)",
  task: 'the task format (three paragraphs: "I want you to …", "Build it by …", "Don\'t stop until …")',
};

/** The lint problems that keep a work item from being built against. */
const FORMAT_LINT_CODES: ReadonlySet<LintCode> = new Set([
  "missing-section",
  "missing-paragraph",
  "empty-done-criteria",
]);

/**
 * What keeps `text` from being a work item in one of `formats` (an epic, or a task): not
 * detected as one of them, or missing a required section or paragraph, or a task's paragraph 3
 * without a done criterion (`lintWorkItem`). Null when it is fine.
 */
function formatProblem(text: string, formats: readonly WorkItemFormat[]): string | null {
  const detected = workItemFormat(text);
  const format = detected && formats.includes(detected) ? detected : null;
  const problems = lintWorkItem(text, { format: format ?? formats[0] }).filter((p) =>
    FORMAT_LINT_CODES.has(p.code),
  );
  if (format && problems.length === 0) return null;
  const expected = formats.map((f) => FORMAT_NAMES[f]).join(" or ");
  const details = problems.map((p) => p.message).join(" ");
  return format ? details : `it isn't in ${expected}${details ? `: ${details}` : ""}`;
}

/**
 * A triage session's result, trimmed (blank and duplicate open questions dropped, a legacy
 * validation task dropped from the stories, dependency indexes limited to the other stories kept), or
 * the problem with it: a result that doesn't match the schema, a sizing without a reason or
 * whose t-shirt size disagrees with it (XS–M for a Fix or a Story, L–XL for an Epic or a Feature),
 * a description with `## Success Metrics`, `## Quality Gates` or `## Open Questions`, a
 * description not in the format its outcome and size call for (an epic for an Epic, else a
 * task), an epic without stories, a single task with stories, a description ralph would split
 * into stories, a story or sub-issue update that isn't a three-paragraph task, stories/updates
 * that don't fit the outcome, or a Feature without its first cut of epics (or anything to file).
 * A Feature's outcome is always `unchanged`: triage leaves the issue as it is.
 */
export function validateTriageOutput(
  structured: unknown,
): { result: TriageResult } | { problem: string } {
  const parsed = structured === undefined ? undefined : TriageAgentOutput.safeParse(structured);
  if (!parsed?.success) return { problem: problemWith(parsed?.error) };
  const data = parsed.data;
  const title = oneLine(data.title);
  const description = data.description.trim();
  const summary = data.summary.trim();
  const sizing = { size: data.sizing.size, reason: data.sizing.reason.trim() };
  if (!title) return { problem: "the title is empty" };
  if (!description) return { problem: "the description is empty" };
  if (!summary) return { problem: "the summary is empty" };
  if (!sizing.reason) return { problem: "the sizing has no reason" };
  const large = sizing.size === "epic" || sizing.size === "feature";
  if (large !== LARGE_SIZES.has(data.size)) {
    return {
      problem: `${sizing.size === "epic" ? "an" : "a"} ${sizing.size} is ${large ? "L or XL" : "XS, S or M"}, but the size is ${data.size}`,
    };
  }
  const feature = sizing.size === "feature";
  const epic = sizing.size === "epic";
  /** The size with its article ("an epic", "a story"). */
  const aSize = `${epic ? "an" : "a"} ${sizing.size}`;
  const legacy = legacyOnlySection(description);
  if (legacy && !feature) {
    return { problem: `the description has a \`${legacy}\` section: no work item has one` };
  }
  if (hasOpenQuestionsHeading(description)) {
    return {
      problem: "the description contains `## Open Questions`: report them in `openQuestions`",
    };
  }
  if (!feature && parsePrd(description)) {
    return {
      problem:
        "a coding task would split the description into stories: no story-style headings or `userStories` JSON",
    };
  }
  if (data.outcome === "reformat" && !epic) {
    return {
      problem: `outcome reformat puts an epic into the format, but the work is a ${sizing.size}`,
    };
  }
  if (!feature) {
    const formats: readonly WorkItemFormat[] = epic ? ["epic"] : ["task"];
    const descriptionProblem = formatProblem(description, formats);
    if (descriptionProblem) return { problem: `the description: ${descriptionProblem}` };
  }
  if (!epic && data.stories.length > 0) {
    return {
      problem: feature
        ? "a feature files nothing, but there are `stories`: list its epics in `featureEpics`"
        : `${aSize} is a single task, but there are \`stories\``,
    };
  }
  if (data.outcome !== "prd" && data.stories.length > 0) {
    return { problem: `outcome ${data.outcome} can't create \`stories\`` };
  }
  if (data.outcome !== "reformat" && data.subIssueUpdates.length > 0) {
    return { problem: `outcome ${data.outcome} can't have \`subIssueUpdates\`` };
  }

  const featureEpics: TriageAgentOutput["featureEpics"] = [];
  for (const [i, e] of data.featureEpics.entries()) {
    const epicTitle = oneLine(e.title);
    const epicSummary = e.summary.trim();
    if (!epicTitle) return { problem: `feature epic ${i} has no title` };
    if (!epicSummary) return { problem: `feature epic ${i} ("${epicTitle}") has no summary` };
    featureEpics.push({ title: epicTitle, summary: epicSummary });
  }
  if (feature && featureEpics.length === 0) {
    return { problem: "a feature needs a first cut of its epics in `featureEpics`" };
  }
  if (!feature && featureEpics.length > 0) {
    return { problem: `${aSize} has no \`featureEpics\`: only a feature does` };
  }

  // The indexes, in `data.stories`, of the stories kept, and each one's index in `stories`.
  const kept = [...data.stories.keys()].filter(
    (i) => !isLegacyValidationTask(oneLine(data.stories[i]!.title)),
  );
  const keptIndex = new Map(kept.map((from, to) => [from, to]));
  if (data.outcome === "prd" && epic && kept.length === 0) {
    return { problem: "an epic rewritten from the issue needs its tasks in `stories`" };
  }
  const stories: TriageAgentOutput["stories"] = [];
  for (const [i, from] of kept.entries()) {
    const s = data.stories[from]!;
    const storyTitle = oneLine(s.title);
    const body = s.body.trim();
    if (!storyTitle) return { problem: `story ${from} has no title` };
    const storyLegacy = legacyOnlySection(body);
    if (storyLegacy) {
      return { problem: `story ${from} ("${storyTitle}") has a \`${storyLegacy}\` section` };
    }
    const storyProblem = formatProblem(body, ["task"]);
    if (storyProblem) return { problem: `story ${from} ("${storyTitle}"): ${storyProblem}` };
    const dependsOn = [
      ...new Set(
        s.dependsOn
          .filter((d) => Number.isInteger(d))
          .map((d) => keptIndex.get(d))
          .filter((d): d is number => d !== undefined && d !== i),
      ),
    ];
    stories.push({
      title: storyTitle,
      body,
      kind: s.kind,
      priority: s.priority,
      dependsOn,
      manual: s.manual,
    });
  }

  const subIssueUpdates: TriageAgentOutput["subIssueUpdates"] = [];
  for (const u of data.subIssueUpdates) {
    const id = u.id.trim();
    const updateTitle = oneLine(u.title);
    const body = u.body.trim();
    if (!id || subIssueUpdates.some((x) => x.id === id)) continue;
    if (!updateTitle) return { problem: `the update of sub-issue ${id} has no title` };
    const updateLegacy = legacyOnlySection(body);
    if (updateLegacy) {
      return { problem: `the update of sub-issue ${id} has a \`${updateLegacy}\` section` };
    }
    if (!VALIDATION_TITLE.test(updateTitle)) {
      const updateProblem = formatProblem(body, ["task"]);
      if (updateProblem) return { problem: `the update of sub-issue ${id}: ${updateProblem}` };
    }
    const blockedBy = [...new Set(u.blockedBy.map((b) => b.trim()).filter((b) => b && b !== id))];
    subIssueUpdates.push({ id, title: updateTitle, body, priority: u.priority, blockedBy });
  }

  let bug: TriageBugResult | null = null;
  const questions = [...data.openQuestions];
  if (sizing.size === "fix") {
    if (!data.bug) {
      return { problem: "a fix needs its bug triage in `bug` (cause, reproduction, behavior)" };
    }
    const read = readBugTriage(data.bug);
    if ("problem" in read) return read;
    bug = read.bug;
    if (read.question) questions.push(read.question);
  } else if (data.bug) {
    return { problem: `${aSize} has no \`bug\`: only a fix does` };
  }

  const openQuestions: string[] = [];
  for (const q of questions) {
    const question = q.trim();
    if (question && !openQuestions.includes(question)) openQuestions.push(question);
  }

  return {
    result: {
      outcome: feature ? "unchanged" : data.outcome,
      sizing,
      title,
      // Only a single task is a Fix: an epic's kind comes from its tasks.
      kind: sizing.size === "fix" ? "fix" : "story",
      description,
      size: data.size,
      openQuestions,
      stories,
      subIssueUpdates,
      featureEpics,
      bug,
      summary,
    },
  };
}

/** Longest PR/MR body a describe session's description is cut to. */
export const MAX_PULL_REQUEST_BODY_LENGTH = 60_000;

/** A title within `max` characters, cut at a word boundary when it's longer. */
export function fitTitle(title: string, max = PR_TITLE_MAX_LENGTH): string {
  const line = title.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * A describe session's title and description as they are published: the
 * title fitted (`fitTitle`), the body cut to `MAX_PULL_REQUEST_BODY_LENGTH`.
 */
export function fitPullRequestDescription(text: { title: string; body: string }): {
  title: string;
  body: string;
} {
  return {
    title: fitTitle(text.title),
    body:
      text.body.length > MAX_PULL_REQUEST_BODY_LENGTH
        ? `${text.body.slice(0, MAX_PULL_REQUEST_BODY_LENGTH - 1)}…`
        : text.body,
  };
}
