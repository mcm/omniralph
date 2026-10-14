/**
 * Structured results of ralph's Claude sessions: the zod schemas, the JSON schemas passed to the
 * Agent SDK as `outputFormat`, and readers that validate and normalise a session's result.
 */
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
}

/** At most this many recommendations are kept from one story session. */
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
      "Posted to Linear: what you did, or precisely what is in the way and what would unblock it.",
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
      }),
    )
    .describe(
      "Work outside this story's scope, in this project, for the orchestrator to file as new stories. Never work for another project or repository. Empty when there is none.",
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
export type StoryOutcome = Omit<StoryAgentOutput, "followUps" | "recommendations"> & {
  followUps: FollowUp[];
  recommendations?: Recommendation[];
};

/** `outputFormat` schema of a story session. */
export const STORY_OUTPUT_SCHEMA = jsonSchema(StoryAgentOutput);

/**
 * A story session's structured result, with follow-ups and recommendations trimmed, deduplicated by title
 * and capped. A result
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
    followUps.push({ title, description: f.description.trim(), ...(f.manual && { manual: true }) });
  }
  const recommendations: Recommendation[] = [];
  for (const r of parsed.data.recommendations ?? []) {
    const title = r.title.replace(/\s+/g, " ").trim();
    if (!title || recommendations.some((x) => x.title.toLowerCase() === title.toLowerCase())) {
      continue;
    }
    recommendations.push({ title, description: r.description.trim() });
  }
  const commit = parsed.data.commit?.summary.trim()
    ? { summary: parsed.data.commit.summary.replace(/\s+/g, " ").trim() }
    : undefined;
  // A metric without a name or a finite value is dropped, not an invalid result.
  const { metric: reported, recommendations: _, ...rest } = parsed.data;
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
      "Posted to the Linear thread: what you did, with links (e.g. the pull/merge request URL).",
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

/** The t-shirt sizes of a triage; L and larger become epics. */
export const TRIAGE_OUTPUT_SIZES = ["XS", "S", "M", "L", "XL"] as const;
const EPIC_SIZES = new Set<string>(["L", "XL"]);

const LinearPriority = z
  .literal([1, 2, 3, 4])
  .describe("Linear priority: 1 Urgent, 2 High, 3 Medium, 4 Low.");

/** The structured result a triage session ends with (the shared `TriageOutcome` plus a summary). */
export const TriageAgentOutput = z.object({
  outcome: z
    .enum(["prd", "reformat", "unchanged"])
    .describe(
      "prd: the issue (with no sub-issues) is rewritten as a PRD. reformat: an issue already planned with sub-issues is put into the PRD format, sub-issues included. unchanged: it already is a PRD in the format.",
    ),
  title: z.string().describe("The issue's title: descriptive but concise."),
  description: z
    .string()
    .describe(
      "The PRD in markdown: the issue's new description, without a `## Open Questions` section.",
    ),
  size: z
    .enum(TRIAGE_OUTPUT_SIZES)
    .describe("T-shirt size of the whole body of work. L or larger is an epic with sub-issues."),
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
            "User story sentence, optional context, then a `## Acceptance Criteria` checklist. No IDs or metadata.",
          ),
        priority: LinearPriority,
        dependsOn: z
          .array(z.number())
          .describe("0-based indexes, in `stories`, of the stories this one is blocked by."),
        manual: z.boolean().describe("True for a step only a person can do."),
      }),
    )
    .describe(
      "outcome prd, L or larger only: the sub-issues to create, in order, the validation story last. Empty otherwise.",
    ),
  subIssueUpdates: z
    .array(
      z.object({
        id: z.string().describe("The existing sub-issue's id, as given in the prompt."),
        title: z.string().describe("The plain story title, without IDs."),
        body: z
          .string()
          .describe("The story body, ending with a `## Acceptance Criteria` checklist."),
        priority: LinearPriority,
        blockedBy: z.array(z.string()).describe("Ids of the sibling sub-issues it is blocked by."),
      }),
    )
    .describe(
      "outcome reformat only: Backlog/Todo sub-issues rewritten in the story format. Empty otherwise.",
    ),
  summary: z
    .string()
    .describe(
      "Posted to the Linear session: the outcome, size and why, the structure, and how many open questions remain.",
    ),
});
export type TriageAgentOutput = z.infer<typeof TriageAgentOutput>;

/** `outputFormat` schema of a triage session. */
export const TRIAGE_OUTPUT_SCHEMA = jsonSchema(TriageAgentOutput);

/** Longest issue title kept (Linear's limit). */
export const MAX_TRIAGE_TITLE = 255;

function oneLine(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, MAX_TRIAGE_TITLE).trim();
}

const QUALITY_GATES_HEADING = /^##[ \t]+Quality Gates[ \t]*$/im;
const ACCEPTANCE_CRITERIA_HEADING = /^##[ \t]+Acceptance Criteria[ \t]*$/im;
const SECTION_HEADING = /^##[ \t]+(.+?)[ \t]*$/gm;

/** Whether `## Acceptance Criteria` is the description's last section. */
function endsWithAcceptanceCriteria(description: string): boolean {
  const last = [...description.matchAll(SECTION_HEADING)].at(-1);
  return last !== undefined && /^Acceptance Criteria$/i.test(last[1]!);
}

/**
 * A triage session's result, trimmed (blank and duplicate open questions dropped, dependency indexes
 * limited to other stories), or the problem with it: a result that doesn't match the schema, a
 * description without `## Quality Gates` or with `## Open Questions`, an epic PRD without stories, a
 * smaller issue with stories, a description ralph would split into stories, a story body without
 * `## Acceptance Criteria`, or stories/updates that don't fit the outcome.
 */
export function validateTriageOutput(
  structured: unknown,
): { result: TriageAgentOutput } | { problem: string } {
  const parsed = structured === undefined ? undefined : TriageAgentOutput.safeParse(structured);
  if (!parsed?.success) return { problem: problemWith(parsed?.error) };
  const data = parsed.data;
  const title = oneLine(data.title);
  const description = data.description.trim();
  const summary = data.summary.trim();
  if (!title) return { problem: "the title is empty" };
  if (!description) return { problem: "the description is empty" };
  if (!summary) return { problem: "the summary is empty" };
  if (!QUALITY_GATES_HEADING.test(description)) {
    return { problem: "the description has no `## Quality Gates` section" };
  }
  if (hasOpenQuestionsHeading(description)) {
    return {
      problem: "the description contains `## Open Questions`: report them in `openQuestions`",
    };
  }
  if (parsePrd(description)) {
    return {
      problem:
        "a coding task would split the description into stories: no story-style headings or `userStories` JSON",
    };
  }
  const epic = EPIC_SIZES.has(data.size);
  if (data.outcome === "prd" && epic && data.stories.length === 0) {
    return { problem: `size ${data.size} is an epic but there are no \`stories\`` };
  }
  if (!epic && data.stories.length > 0) {
    return { problem: `size ${data.size} is a single issue but there are \`stories\`` };
  }
  if (data.outcome === "prd" && !epic && !endsWithAcceptanceCriteria(description)) {
    return { problem: "a single issue must end with its `## Acceptance Criteria` section" };
  }
  if (data.outcome !== "prd" && data.stories.length > 0) {
    return { problem: `outcome ${data.outcome} can't create \`stories\`` };
  }
  if (data.outcome !== "reformat" && data.subIssueUpdates.length > 0) {
    return { problem: `outcome ${data.outcome} can't have \`subIssueUpdates\`` };
  }

  const stories: TriageAgentOutput["stories"] = [];
  for (const [i, s] of data.stories.entries()) {
    const storyTitle = oneLine(s.title);
    const body = s.body.trim();
    if (!storyTitle) return { problem: `story ${i} has no title` };
    if (!ACCEPTANCE_CRITERIA_HEADING.test(body)) {
      return { problem: `story ${i} ("${storyTitle}") has no \`## Acceptance Criteria\`` };
    }
    const dependsOn = [
      ...new Set(
        s.dependsOn.filter(
          (d) => Number.isInteger(d) && d >= 0 && d < data.stories.length && d !== i,
        ),
      ),
    ];
    stories.push({ title: storyTitle, body, priority: s.priority, dependsOn, manual: s.manual });
  }

  const subIssueUpdates: TriageAgentOutput["subIssueUpdates"] = [];
  for (const u of data.subIssueUpdates) {
    const id = u.id.trim();
    const updateTitle = oneLine(u.title);
    const body = u.body.trim();
    if (!id || subIssueUpdates.some((x) => x.id === id)) continue;
    if (!updateTitle) return { problem: `the update of sub-issue ${id} has no title` };
    if (!ACCEPTANCE_CRITERIA_HEADING.test(body)) {
      return { problem: `the update of sub-issue ${id} has no \`## Acceptance Criteria\`` };
    }
    const blockedBy = [...new Set(u.blockedBy.map((b) => b.trim()).filter((b) => b && b !== id))];
    subIssueUpdates.push({ id, title: updateTitle, body, priority: u.priority, blockedBy });
  }

  const openQuestions: string[] = [];
  for (const q of data.openQuestions) {
    const question = q.trim();
    if (question && !openQuestions.includes(question)) openQuestions.push(question);
  }

  return {
    result: {
      outcome: data.outcome,
      title,
      description,
      size: data.size,
      openQuestions,
      stories,
      subIssueUpdates,
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
