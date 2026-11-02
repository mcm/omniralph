/**
 * The plugin-only parts of the skill's shared reference (`common.md`): how
 * Omniralph runs what the skill writes, the interactive steps (clarifying
 * questions with lettered options, prerequisites and manual steps), drafting
 * with the user, writing the plan to Linear, and a worked example. The
 * planning rules between them come from `SHARED_RULES`, never from here.
 */
import type { Fragment } from "../methodology/rules.js";

/** What `common.md` is, and how Omniralph builds what the skill writes. */
export const COMMON_INTRO = `Every mode (\`new\`, \`triage\`, \`edit\`, \`ui-loop\`) writes the same work items,
by the planning rules below. The mode files describe the steps; this file is
the reference for *what the work items look like* and *how they are written to
{{trackerName}}*.

What you write is built by **Omniralph**. For an epic delegated to the
Omniralph {{trackerName}} agent, it takes the next ready task, hands it to a
fresh, unattended Claude session, runs the repo's checks, commits, marks the
task Done and moves on. When every task is done it opens the pull request,
then fixes failed CI and its own review findings on it. Omniralph shows the
agent the epic's description as background and the task's own description as
the work. It reads tasks from **{{trackerName}}'s own fields** (identifier,
title, priority, sub-issue order, workflow state, labels and "blocks"
relations) plus the checkboxes in each description, never from identifiers or
metadata written into titles or bodies, so don't write any.`;

/** Asking clarifying questions with lettered options. */
export const CLARIFYING_QUESTIONS: Fragment = {
  id: "clarifying-questions",
  title: "Clarifying questions",
  body: `Before writing (or revising) a plan, ask 3–5 essential clarifying questions,
targeted at the genuine ambiguities. Don't re-ask anything the user's context
or an existing issue already answers: confirm your understanding instead.

### Use lettered options

Format questions with lettered options so the user can answer quickly with
"1A, 2C, 3B" instead of writing paragraphs. Indent the options under each
question:

\`\`\`
1. What is the primary goal of this feature?
   A. Improve user onboarding experience
   B. Increase user retention
   C. Reduce support burden
   D. Other: [please specify]

2. Who is the target user?
   A. New users only
   B. Existing users only
   C. All users
   D. Admin users only

3. What is the scope?
   A. Minimal viable version
   B. Full-featured implementation
   C. Just the backend/API
   D. Just the UI
\`\`\`

### Adaptive questioning

After each response, decide whether to:

- Ask follow-up questions (if answers reveal complexity),
- Ask about a new aspect (if the current area is clear), or
- Write the plan (if you have enough context).

Typically 2–4 rounds are needed, fewer for small, well-specified work.

### Story or fix

Settle early whether the work is new work (a story) or a bug (a fix). For a
bug, ask what happens now, what should happen instead, and what nearby
behavior must not change, unless the issue already says.

### Full scope up front

Everything in the plan is in scope for its epic, and the whole epic gets built.

- When you present a plan, state its full scope. Don't silently trim or defer
  anything the epic needs.
- Don't label tasks, requirements or criteria "future enhancement", "stretch",
  "v2", "nice to have" or similar unless the user marked them that way.
- If something is genuinely optional, name it and ask the user whether it's in
  or out (a lettered question works). If it's in, it's a normal task or
  requirement. If it's out, it goes under \`### Out\`.

### Prerequisites and manual steps

Ask about anything the work depends on that an AI agent working in the repo
cannot do itself, unless the context already answers it:

- **Other {{trackerName}} issues** that must land first (another epic, a backend
  change, a design task). These become "blocks" relations, as the dependency
  rules allow.
- **Steps for a person**: provisioning secrets or credentials, DNS, third-party
  console or app-store setup, data migrations run by operations, design
  sign-off. These become separate **manual** tasks, never acceptance criteria
  on an agent's task.

### The repo's checks

Omniralph runs the repo's own checks after every task, so a plan never lists
commands to run. Don't ask the user for them and don't write them into any
description. A task may still name a command whose output is the evidence for
one of its criteria.`,
};

/** Presenting and drafting tasks with the user. */
export const DRAFTING_TASKS: Fragment = {
  id: "drafting-tasks",
  title: "Drafting tasks with the user",
  body: `**Drafting labels.** While drafting with the user, refer to tasks as US-001,
US-002, … so dependencies are easy to discuss. These labels are for the
conversation only: they never go into {{trackerName}} titles or bodies. Once
the sub-issues exist, their {{trackerName}} identifiers (e.g. \`ENG-12\`) are
the task names: Omniralph uses them in plans, prompts and commit messages
(\`feat(ENG-12): Add priority field to database\`).

**Present each task as:**

\`\`\`
US-001 — Add priority field to database
Kind: Story · Covers: FR-1 · Priority: High · Blocked by: — · Manual: no

As a developer, I want to store task priority in the database so that it
persists across sessions.

Acceptance criteria:
- [ ] ...
\`\`\`

**Sub-issue title:** the plain task title. No \`US-001:\` prefix.

**Order and priority.** Omniralph picks the next task that has no open
blockers: in-progress tasks first, then by **{{trackerName}} priority** (Urgent
first, *No priority* last), then by the sub-issues' order in the parent.

- Blocks relations alone must make the epic run correctly. If a task would
  break when run before another, that's a missing blocks relation: add it.
- Give every task a priority. Use one priority for the whole epic unless some
  tasks genuinely matter more.
- Sub-issue order in the parent is cosmetic: it only breaks ties between tasks
  that are equally ready, which by definition can run in either order. Create
  sub-issues in task order, but never check, report or ask about where they
  ended up in the parent: don't tell the user to drag or reorder them, and
  don't remark that one landed out of place.

**Manual tasks.** A step for a person is its own sub-issue with the **manual**
label (or the label \`{{conventionsFile}}\` names), wired with blocks relations
like any other task. Omniralph never works it; tasks that depend on it wait
until a person moves it to Done.

**Writing quality.** Each task is built by an AI coding agent in one fresh
session, so be explicit and unambiguous, include specific file paths when you
know them, and reference existing patterns in the repo.`,
};

/** How the plan is written to Linear. */
export const TRACKER_STRUCTURE: Fragment = {
  id: "tracker-structure",
  title: "{{trackerName}} structure reference",
  body: `When you write to {{trackerName}} (the exact create-or-update actions are in
each mode file), the target structure is one of:

**Epic (L or larger):**

- A parent issue whose description is the epic, plus the branch line (and a
  repo tag, if the user asked for one).
- One sub-issue per task, created **in task order**, each with:
  - \`parentId\` = the epic, \`title\` = the plain task title, \`description\` =
    the task in the story or fix format;
  - \`priority\` (1 Urgent, 2 High, 3 Medium, 4 Low), always set;
  - \`blockedBy\` = the tasks (and any work items outside the epic) it depends
    on, as the dependency rules allow;
  - the **manual** label (\`addLabels\`) for steps for a person.
- No validation sub-issue: Omniralph audits the epic against its
  requirements before its pull request opens.
- If the epic as a whole waits on other work, make the **epic** \`blockedBy\`
  it: Omniralph won't start any task until it's done.

After creating them:

1. Replace drafting labels with {{trackerName}} identifiers wherever they ended
   up in a description.
2. Verify every dependency you drafted exists as a blocks relation.

**Single task (smaller than L):**

- One issue whose description is a story, or a fix for a bug, with no
  \`Covers:\` line, plus the branch line. No sub-issues.
- Omniralph builds the whole description as one task, and would split it into
  sub-issues if it looked like an epic. So in a single task: no requirement
  list, no task-style headings such as \`### US-001: …\`, and
  \`## Acceptance Criteria\` is the last section.
- Set \`blockedBy\` for any work item it waits on, as for an epic.

Whenever removing a task in {{trackerName}}, **cancel** it (do not delete).
Never modify a sub-issue that is already completed or in progress, and never
restructure an issue, without explicit user confirmation.

### Routing and branch lines

Omniralph routes an issue to a repo by its **team, project or label**,
configured per repo in Omniralph. Expect that routing to be in place, and put
the issue in the team or project (or give it the label) that routes it.

- **Repo tag (only when asked).** Don't add a \`[repo=…]\` tag unless the user
  asks for one. A tag overrides the routing: an issue tagged with a repo that
  doesn't have Omniralph enabled isn't routed at all. When asked, add
  \`[repo=<full path>]\` on its own line, with the repo's full path
  (\`acme/app\`, \`group/subgroup/project\`). One repo per tag, and no branch in
  it.
- **Branch (optional).** If the user wants a specific branch name, add
  \`\`> Branch: \`name\` \`\` on its own line after the sections. Otherwise
  Omniralph uses {{trackerName}}'s branch name for the issue.

### Delegating to Omniralph

Delegating is what starts the run, and it's the user's call. Never offer to
delegate, and don't suggest it as a next step. Only if the user asks, delegate
the epic (or single task) with \`save_issue\` and \`delegate\`, using the agent
name from \`{{conventionsFile}}\`, else \`Omniralph\`.`,
};

/** A worked epic in the planning formats. */
export const EXAMPLE_EPIC = `## Problem

People with a long task list can't tell what matters most, so urgent tasks get
lost among routine ones. Tasks have no notion of priority today.

## Scope

### In

- A priority (high, medium or low) on every task, medium by default
- A priority badge on task cards
- Filtering and sorting the task list by priority

### Out

- Reminders or notifications based on priority
- Setting priority automatically from due dates

## Technical notes

- Reuse the badge component in \`src/components/badge.tsx\` with its color variants.
- Keep filter state in the URL search params, like the status filter.

## Requirements

- FR-1: The system must store a priority of high, medium or low on every task, medium by default.
- FR-2: The system must show each task's priority as a colored badge on its card.
- FR-3: WHEN a user picks a priority filter, the system must list only the tasks with that priority.
- FR-4: IF a task is saved with a priority outside high, medium or low, the system must reject it.`;

/** A worked story of the example epic. */
export const EXAMPLE_STORY = `As a user, I want to see each task's priority at a glance so that I know what needs attention first.

Covers: FR-2

The badge component is \`src/components/badge.tsx\`; task cards are in \`src/tasks/card.tsx\`.

## Acceptance Criteria

- [ ] Each task card shows a priority badge: red for high, yellow for medium, gray for low
- [ ] The badge is visible without hovering or clicking
- [ ] A task without a stored priority shows the medium badge`;

/** A worked fix of the example epic. */
export const EXAMPLE_FIX = `## Current behavior

Sorting the task list by priority puts low before medium: the sort compares the priority names alphabetically.

## Expected behavior

Sorting by priority orders tasks high, then medium, then low, within each status column.

## Unchanged behavior

Sorting by due date and by title orders tasks as it does today, and the sort choice stays in the URL.

## Acceptance Criteria

- [ ] With one task of each priority, sorting by priority lists them high, medium, low
- [ ] Sorting by due date and by title gives the same order as before
- [ ] Reloading the page keeps the chosen sort`;

/** The worked example, around the example epic, story and fix. */
export const WORKED_EXAMPLE: Fragment = {
  id: "worked-example",
  title: "Worked example",
  body: `An epic of size L, titled \`Task priorities\`:

\`\`\`markdown
${EXAMPLE_EPIC}
\`\`\`

One of its stories, titled \`Show priority on task cards\`, priority High,
blocked by the story that stores the priority:

\`\`\`markdown
${EXAMPLE_STORY}
\`\`\`

A fix filed in the same epic, titled \`Sort priorities by rank, not by name\`:

\`\`\`markdown
${EXAMPLE_FIX}
\`\`\`

There is no validation task: Omniralph audits FR-1 to FR-4 before the epic's
pull request opens.`,
};
