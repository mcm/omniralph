/**
 * The shared planning rules, each written once as a Markdown fragment: the
 * formats (with their templates), sizing, splitting by feature, checkable
 * criteria, constraints and guidance, requirement wording, the epic audit and the dependency rules. The triage prompts,
 * the story prompts and the plugin compose their text from these.
 *
 * A fragment may name the tracker as `{{trackerName}}` and the repo's tracker
 * conventions file as `{{conventionsFile}}`; `renderFragment` fills them in.
 * No fragment names a specific tracker.
 */
import {
  COVERS_LABEL,
  EPIC_SECTIONS,
  EPIC_TEMPLATE,
  REQUIREMENT_PREFIX,
  SCOPE_PARTS,
  TASK_PARAGRAPHS,
  TASK_TEMPLATE,
  VALIDATION_AUDIT_TITLE,
  heading,
} from "./templates.js";

/** A piece of the methodology: a titled block of Markdown. */
export interface Fragment {
  /** A stable identifier, e.g. `sizing`. */
  id: string;
  /** The fragment's heading text, without `#`s. */
  title: string;
  /** The Markdown body, without the heading. */
  body: string;
}

function fence(text: string): string {
  return `\`\`\`markdown\n${text}\n\`\`\``;
}

function code(text: string): string {
  return `\`${text}\``;
}

/** What a work item is: its kind (Story or Fix) and its role (task, epic, feature). */
export const WORK_ITEMS_RULE: Fragment = {
  id: "work-items",
  title: "Work items",
  body: `Every work item has a kind and a role.
- **Kind.** A **Story** is new work or an enhancement. A **Fix** is a bug: something that should work and doesn't. Omniralph tells a Fix by its bug label; everything else is a Story. Both are written in the task format.
- **Role.** A **task** is one piece of work an agent finishes in one session; it has no sub-issues. An **epic** is a set of tasks (its sub-issues) that ship together in one pull request, once every task is done. A **feature** groups epics; nobody builds a feature directly. A task with no epic is a **standalone task**, and counts as an epic of one.
- What an agent builds against is the task and its epic, never a planning document. Outcomes and success measures belong in planning documents, not in epics or tasks.`,
};

/** The epic format and its template. */
export const EPIC_FORMAT_RULE: Fragment = {
  id: "epic-format",
  title: "Epic format",
  body: `An epic's description has these sections, in this order, each as a plain ${code("##")} heading. Leave out ${code(heading(EPIC_SECTIONS.design))} and ${code(heading(EPIC_SECTIONS.technicalNotes))} when there is nothing to say; the others are always present.
- ${code(heading(EPIC_SECTIONS.problem))}: who has the problem, what it is today and why it matters now.
- ${code(heading(EPIC_SECTIONS.scope))}: what the epic delivers under ${code(`### ${SCOPE_PARTS.in}`)} and what it deliberately leaves out under ${code(`### ${SCOPE_PARTS.out}`)}. Only what is really out of scope goes under ${SCOPE_PARTS.out}: never relabel requested work as later or optional; if part of it truly is optional, ask a person.
- ${code(heading(EPIC_SECTIONS.design))} (optional): UI and UX decisions, flows, components to reuse.
- ${code(heading(EPIC_SECTIONS.technicalNotes))} (optional): constraints, integration points, real file paths, patterns to follow.
- ${code(heading(EPIC_SECTIONS.requirements))}: the numbered requirements (see Requirement wording). Every requirement is built by at least one task.

Nothing else: no title heading (the title is its own field), no checklist, no other sections. The repo decides which checks run on every task, so an epic never lists commands to run.

${fence(EPIC_TEMPLATE)}`,
};

/** The task format, its Story and Fix kinds, and its template. */
export const TASK_FORMAT_RULE: Fragment = {
  id: "task-format",
  title: "Task format",
  body: `A task's description is three paragraphs, in this order, each opening with its own words. Story and Fix are kinds of the same shape; a task is a Fix when it carries the bug label.
1. **${code(`${TASK_PARAGRAPHS.build.opening} …`)}** What to build, in one paragraph. For a Story: ${TASK_PARAGRAPHS.build.story}. For a Fix: ${TASK_PARAGRAPHS.build.fix}.
2. **${code(`${TASK_PARAGRAPHS.approach.opening} …`)}** How to build it. For a Story: ${TASK_PARAGRAPHS.approach.story}. For a Fix: ${TASK_PARAGRAPHS.approach.fix}.
3. **${code(`${TASK_PARAGRAPHS.done.opening} …`)}** When it is done, as prose or a short list. For a Story: ${TASK_PARAGRAPHS.done.story}. For a Fix: ${TASK_PARAGRAPHS.done.fix}.

The agent building the task gets all three paragraphs, with the third as its stop condition. The agent verifying it gets only the first and third, with the change, so it judges the result rather than the approach.

Nothing else: no headings, no ${code(`${COVERS_LABEL}:`)} line, no checklist section. Don't repeat the title, and don't add identifiers, priority, dependency or metadata lines: those are {{trackerName}} fields. Never refer to another task by a drafting label such as US-001.

${fence(TASK_TEMPLATE)}`,
};

/** What belongs in a task's third paragraph and what its second paragraph is. */
export const TASK_CONSTRAINTS_RULE: Fragment = {
  id: "task-constraints",
  title: "Constraints and guidance",
  body: `- Every constraint that must hold goes in the ${code(TASK_PARAGRAPHS.done.opening)} paragraph, never in the ${code(TASK_PARAGRAPHS.approach.opening)} paragraph: no new table, never force-push, a behavior that must not change. The agent verifying the task never sees the second paragraph, so a constraint written there goes unchecked.
- The ${code(TASK_PARAGRAPHS.approach.opening)} paragraph is guidance: where to look and how it would likely be built. The agent building the task may depart from it when the code shows a better way, so it holds nothing the task is judged by.`,
};

/** The epic audit Omniralph runs before an epic's pull request, in place of a validation task. */
export const EPIC_AUDIT_RULE: Fragment = {
  id: "epic-audit",
  title: "Epic audit",
  body: `When every task of an epic is done, Omniralph audits the epic against its requirements before its pull request opens: it checks each requirement against the code, and files each gap it finds as a new task in the epic. So an epic carries only real work:
- Plan no validation or audit task (no ${code(VALIDATION_AUDIT_TITLE)} task). Keep the epic's requirements in its description, where the audit reads them.
- An epic that already has a ${code(VALIDATION_AUDIT_TITLE)} task keeps it: it still runs as a task, and the epic is audited too.`,
};

/** Sizing: Fix, Story, Epic or Feature, with the t-shirt estimate of each. */
export const SIZING_RULE: Fragment = {
  id: "sizing",
  title: "Sizing",
  body: `Size the whole body of work, not one piece of it. Weigh the number of distinct requirements, the surface it touches (database, API, UI, integrations, infrastructure), the unknowns and risk, and how many focused agent sessions it would realistically take. It is one of four sizes, each with a t-shirt estimate:
- **Fix (XS, S or M): a single task fixing a bug.** One task in the task format, with its done criteria in its own description and no sub-issues; it gets the bug label.
- **Story (XS, S or M): a single task of new work.** The same shape as a Fix, without the bug label.
- **Epic (L or XL): a set of tasks shipped in one pull request.** One task per story or fix, and no validation task: the epic audit checks the requirements.
- **Feature (L or XL): a set of epics.** Too big for one pull request: it is planned as a feature, epic by epic, rather than filed as one epic. Nothing is built from it directly.`,
};

/** Splitting an epic into tasks by feature. */
export const SPLITTING_RULE: Fragment = {
  id: "splitting",
  title: "Splitting into tasks",
  body: `Each task is built in one fresh, unattended agent session, so it must be small enough to finish in one.
- Split by feature boundary, never by development phase: "Sign-in" is one story, not scaffolding, logic, tests and polish as four.
- The tests, error handling, hardening and documentation of new code belong in the task that adds the code, never in a task of their own.
- Order the tasks so earlier ones enable later ones, and block a task only on the tasks it really depends on.
- Every task is in scope for the epic, and every requirement is built by at least one task.
- A step only a person can do (credentials, DNS, third-party consoles, a migration run by operations, a design sign-off) is its own manual task, never a criterion on an agent's task.`,
};

/** What makes an acceptance criterion checkable. */
export const CHECKABLE_CRITERIA_RULE: Fragment = {
  id: "checkable-criteria",
  title: "Checkable criteria",
  body: `A task's ${code(TASK_PARAGRAPHS.done.opening)} paragraph holds its done criteria: criteria the loop can check, each one evidence to check, not a test to write. Each one names something an agent can confirm inside the repo, in the code, the output of a command or the behavior of the running software: "Deleting a project asks for confirmation first", not "Works correctly".
- Tests are written where the repo's conventions call for them on new behavior, never to prove a criterion. Don't phrase a criterion as a test to add.
- A fix adds a regression test only where the affected code already has tests.
- No criterion is an outcome or metric: nothing measured after merge, such as adoption, a percentage improvement, fewer support requests or user satisfaction. Those belong in planning documents.
- Nothing that needs human judgement, production access or an outside account.`,
};

/** How to word a requirement. */
export const REQUIREMENT_WORDING_RULE: Fragment = {
  id: "requirement-wording",
  title: "Requirement wording",
  body: `Requirements are a bullet list, numbered from 1: ${code(`- ${REQUIREMENT_PREFIX}1: The system must …`)}. Never headings.
- One behavior per requirement, explicit and unambiguous, stated as what the system must do.
- Add a condition only to conditional behavior: WHEN for an event or state (${code(`- ${REQUIREMENT_PREFIX}2: WHEN a run fails, the system must …`)}), IF for an unwanted condition (${code(`- ${REQUIREMENT_PREFIX}3: IF the token has expired, the system must …`)}). Behavior that always holds has no condition.
- Tasks don't name the requirements they build: the epic audit checks every requirement against the finished branch on its own. Keep identifiers stable all the same, since people and audits refer to them.`,
};

/** The dependency rules between work items. */
export const DEPENDENCY_RULE: Fragment = {
  id: "dependency-rules",
  title: "Dependency rules",
  body: `A "blocks" relation is the only thing that stops work from starting early, and Omniralph ships an epic only once every task in it is done. So:
- A task in an epic may be blocked only by another epic, a standalone task, or a task in its own epic.
- An epic may be blocked only by another epic or a standalone task.
- A standalone task counts as an epic of one.
- Nothing is blocked by a feature: block on the epic inside it the work waits for.
- When work waits for a task in another epic, block it on that task's epic instead.
- A task is never blocked by its own epic, and an epic never by one of its own tasks.
- Work found while building an epic that can't land until the epic ships becomes a standalone task blocked by the epic, never a blocker of the task that found it.`,
};

/**
 * Every shared rule, in the order the methodology presents them: the work
 * items, the formats and their templates, requirement wording, criteria,
 * constraints and guidance, sizing, splitting, the epic audit and the dependency rules.
 */
export const SHARED_RULES: readonly Fragment[] = [
  WORK_ITEMS_RULE,
  EPIC_FORMAT_RULE,
  TASK_FORMAT_RULE,
  REQUIREMENT_WORDING_RULE,
  CHECKABLE_CRITERIA_RULE,
  TASK_CONSTRAINTS_RULE,
  SIZING_RULE,
  SPLITTING_RULE,
  EPIC_AUDIT_RULE,
  DEPENDENCY_RULE,
];

/** What a fragment's placeholders are filled with. */
export interface MethodologyContext {
  /** The tracker's display name, for `{{trackerName}}`. */
  trackerName: string;
  /** The repo's tracker conventions file, for `{{conventionsFile}}`. */
  conventionsFile: string;
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * Markdown with its `{{trackerName}}` and `{{conventionsFile}}` placeholders
 * filled in. Throws on any other placeholder, so a typo never reaches a prompt.
 */
export function renderFragment(markdown: string, context: MethodologyContext): string {
  return markdown.replace(PLACEHOLDER, (match, name: string) => {
    if (name === "trackerName") return context.trackerName;
    if (name === "conventionsFile") return context.conventionsFile;
    throw new Error(`Unknown methodology placeholder ${match}`);
  });
}

/** A fragment as a Markdown section, its heading at `level` (2 for `##`). */
export function renderSection(
  fragment: Fragment,
  level: number,
  context: MethodologyContext,
): string {
  return `${"#".repeat(level)} ${fragment.title}\n\n${renderFragment(fragment.body, context)}`;
}
