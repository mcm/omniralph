/**
 * The triage methodology: the steps an unattended triage session follows to
 * turn a tracker issue into an epic, a story or a fix, composed from the
 * shared rules (each written once in `rules.ts`) and the triage-only steps
 * below. The triage-only steps name the fields of the triage result
 * (`outcome`, `description`, `size`, `stories`, `subIssueUpdates`,
 * `openQuestions`, `summary`).
 */
import {
  type Fragment,
  type MethodologyContext,
  SHARED_RULES,
  renderFragment,
  renderSection,
} from "./rules.js";
import { COVERS_LABEL, VALIDATION_AUDIT_TITLE } from "./templates.js";

const TRIAGE_INTRO = `What you write is built by Omniralph, which runs each task as one fresh, unattended AI coding session: it runs the repo's checks, commits, marks the task done and moves on, and opens the pull request once every task in the epic is done. Precise, checkable acceptance criteria matter. Omniralph reads tasks from {{trackerName}}'s own fields (identifier, title, priority, sub-issue order, state, labels, "blocks" relations) plus the checkboxes in each description, never from identifiers or metadata written into titles or bodies.`;

/** Reading the issue and the repo. */
export const TRIAGE_UNDERSTAND_STEP: Fragment = {
  id: "triage-understand",
  title: "Understand the issue",
  body: `- Read the title, description, comments, sub-issues and blockers below. Work out what is already decided, what you can infer about intent, and what is missing.
- If a repo is checked out, read it targeted, not wholesale: the files the work touches, existing components and patterns to reuse. Cite real file paths in technical notes and context.
- If the repo has a \`{{conventionsFile}}\` at its root, read it first and honour it throughout: it holds the project's conventions for {{trackerName}} issues (e.g. whether to add a \`> Branch:\` line, the manual label, standard manual tasks).
- Decide whether the issue is a bug (a Fix) or new work (a Story).`,
};

/** Choosing the triage outcome. */
export const TRIAGE_OUTCOME_STEP: Fragment = {
  id: "triage-outcome",
  title: "Decide what kind of triage this is (`outcome`)",
  body: `- \`prd\`: the issue has no sub-issues and isn't yet written in the formats below (a one-liner, a bug report, loose notes, a partial spec, or an older format). Write it out; if it is L or larger, also write its tasks.
- \`reformat\`: the issue is already planned (it has sub-issues) but isn't in the formats below. Reformat it, don't replan it: keep its scope, decisions, tasks and their order, and fix the format of the description and of every Backlog or Todo sub-issue (\`subIssueUpdates\`). Never add tasks beside existing sub-issues (\`stories\` stays empty), and never drop, merge or cancel sub-issues; if work seems missing, or a sub-issue seems wrong or redundant, say so in an open question.
- \`unchanged\`: the issue is already in the formats below and needs no rewrite. Return its current title and description as they are (without any \`## Open Questions\` section), with no tasks or sub-issue updates.
- An issue whose description holds user stories but has no sub-issues (e.g. a \`### US-001: …\` list) is \`prd\`: rewrite it, with its stories as tasks when it is L or larger.
- Omniralph never touches work in progress: only sub-issues in state type \`backlog\` or \`unstarted\` can be updated.`,
};

/** Writing the description. */
export const TRIAGE_DESCRIPTION_STEP: Fragment = {
  id: "triage-description",
  title: "Write the description (`description`)",
  body: `The description becomes the issue's description, and Omniralph shows it to the agent working each task. Size the work first (see Sizing), then write:
- **L or larger:** the epic format. The tasks go in \`stories\`, never into the description.
- **Smaller than L:** a single task, in the fix format when the issue is a bug and the story format otherwise, with no \`${COVERS_LABEL}:\` line. Omniralph builds the whole description as one task, so it has no requirement list, no story-style headings such as \`### US-001: …\`, and its \`## Acceptance Criteria\` is the last section.

Never write a \`## Open Questions\` section yourself: report open questions in \`openQuestions\` and Omniralph adds the section at the end.

Branch line: by default add none. Add \`\`> Branch: \`name\` \`\` on its own line after the sections only when the issue or \`{{conventionsFile}}\` asks for it (keep one that is already there). Never add a \`[repo=…]\` tag: repos are routed by their settings, not by the description.`,
};

/** Reporting the size. */
export const TRIAGE_SIZE_STEP: Fragment = {
  id: "triage-size",
  title: "Report the size (`size`)",
  body: `Report the size by the Sizing rule, and mention it with a one-line rationale in your summary. For \`reformat\` and \`unchanged\`, size the work as planned.`,
};

/** Writing an epic's tasks. */
export const TRIAGE_STORIES_STEP: Fragment = {
  id: "triage-stories",
  title: "Write the tasks (`stories`; `prd` epics only, L or larger)",
  body: `Each entry becomes one sub-issue of the epic, in the story or fix format, split by the Splitting rule.
- \`title\`: the plain task title, with no \`US-001:\` prefix or other identifiers.
- \`body\`: the description, in the story format (or the fix format for a bug in the epic).
- \`priority\`: 1 Urgent, 2 High, 3 Medium, 4 Low. Priority beats order when Omniralph picks the next task, so use one priority for the whole epic, or priorities that agree with the order on purpose.
- \`dependsOn\`: the 0-based indexes, in \`stories\`, of the tasks it really depends on. These become "blocks" relations.
- \`manual\`: true for a step only a person can do.
- The **last** entry is the validation audit, titled \`${VALIDATION_AUDIT_TITLE}\`, depending on every other entry.`,
};

/** Reformatting existing sub-issues. */
export const TRIAGE_REFORMAT_STEP: Fragment = {
  id: "triage-reformat",
  title: "Reformat sub-issues (`subIssueUpdates`; `reformat` only)",
  body: `For each sub-issue in state type \`backlog\` or \`unstarted\` that isn't in the story or fix format, add an entry with its \`id\` (as given below), its title without identifier prefixes, its body in the story or fix format (keep its intent and criteria; drop metadata sections, identifiers, priority and dependency lines, and turn its criteria into a \`## Acceptance Criteria\` checklist), its \`priority\` (1–4; keep the current one unless it has none) and \`blockedBy\` (the \`id\`s of the sibling sub-issues it depends on, and the identifiers of work items outside this issue it is blocked by, including the existing relations under Blocked by; Omniralph applies the Dependency rules). Leave out sub-issues that are already fine and every sub-issue in any other state.`,
};

/** Turning what's left into open questions. */
export const TRIAGE_OPEN_QUESTIONS_STEP: Fragment = {
  id: "triage-open-questions",
  title: "Open questions (`openQuestions`)",
  body: `You can't ask anyone during the session. Answer what you can from the issue, comments, sub-issues, blockers and source, and make reasonable, conventional choices for minor details (mention notable ones under technical notes). Every ambiguity left that would change the scope, the behavior, the acceptance criteria or the structure becomes one open question: specific, self-contained and answerable in a sentence, with lettered options when that helps (e.g. "Who can delete a project? A. Owners only B. Owners and admins"). Don't ask about anything the issue already answers. Leave \`openQuestions\` empty when nothing is left: the issue then moves to Todo, ready for Omniralph. With open questions it stays in Backlog, and Omniralph won't start it until they are answered.
- A description that already ends with a \`## Open Questions\` section holds the questions of an earlier triage: fold the answers given in the comments or the reply into the description, and keep only the questions still unanswered.`,
};

/** The summary for the thread. */
export const TRIAGE_SUMMARY_STEP: Fragment = {
  id: "triage-summary",
  title: "Summary (`summary`)",
  body: `A few lines for the thread on {{trackerName}}: the outcome, the size and why, the structure (a single story or fix, an epic with N tasks, or which sub-issues were reformatted), and how many open questions remain.`,
};

/** The triage-only steps, in order. */
export const TRIAGE_STEPS: readonly Fragment[] = [
  TRIAGE_UNDERSTAND_STEP,
  TRIAGE_OUTCOME_STEP,
  TRIAGE_DESCRIPTION_STEP,
  TRIAGE_SIZE_STEP,
  TRIAGE_STORIES_STEP,
  TRIAGE_REFORMAT_STEP,
  TRIAGE_OPEN_QUESTIONS_STEP,
  TRIAGE_SUMMARY_STEP,
];

/**
 * The triage methodology for a tracker: a `## How to triage` section with the
 * numbered triage steps, then a `## Planning rules` section with every shared
 * rule (formats and templates, requirement wording, criteria, sizing,
 * splitting, the validation audit and the dependency rules).
 */
export function renderTriageMethodology(context: MethodologyContext): string {
  const steps = TRIAGE_STEPS.map((step, index) =>
    renderSection({ ...step, title: `${index + 1}. ${step.title}` }, 3, context),
  );
  const rules = SHARED_RULES.map((rule) => renderSection(rule, 3, context));
  return [
    "## How to triage",
    renderFragment(TRIAGE_INTRO, context),
    ...steps,
    "## Planning rules",
    ...rules,
  ].join("\n\n");
}
