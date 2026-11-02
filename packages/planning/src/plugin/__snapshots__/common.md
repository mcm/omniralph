<!-- Generated from the omniralph repo (packages/planning/src/plugin, built by scripts/build-prd-plugin.ts). Do not edit by hand: change it in the omniralph repo, and CI publishes it here. -->

# Shared planning methodology

Every mode (`new`, `triage`, `edit`, `ui-loop`) writes the same work items,
by the planning rules below. The mode files describe the steps; this file is
the reference for *what the work items look like* and *how they are written to
Linear*.

What you write is built by **Omniralph**. For an epic delegated to the
Omniralph Linear agent, it takes the next ready task, hands it to a
fresh, unattended Claude session, runs the repo's checks, commits, marks the
task Done and moves on. When every task is done it opens the pull request,
then fixes failed CI and its own review findings on it. Omniralph shows the
agent the epic's description as background and the task's own description as
the work. It reads tasks from **Linear's own fields** (identifier,
title, priority, sub-issue order, workflow state, labels and "blocks"
relations) plus the checkboxes in each description, never from identifiers or
metadata written into titles or bodies, so don't write any.

---

## Clarifying questions

Before writing (or revising) a plan, ask 3–5 essential clarifying questions,
targeted at the genuine ambiguities. Don't re-ask anything the user's context
or an existing issue already answers: confirm your understanding instead.

### Use lettered options

Format questions with lettered options so the user can answer quickly with
"1A, 2C, 3B" instead of writing paragraphs. Indent the options under each
question:

```
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
```

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
  requirement. If it's out, it goes under `### Out`.

### Prerequisites and manual steps

Ask about anything the work depends on that an AI agent working in the repo
cannot do itself, unless the context already answers it:

- **Other Linear issues** that must land first (another epic, a backend
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
one of its criteria.

---

## Planning rules

These rules are the same ones Omniralph's own triage follows.

### Work items

Every work item has a kind and a role.
- **Kind.** A **Story** is new work or an enhancement. A **Fix** is a bug: something that should work and doesn't. Omniralph tells a Fix by its bug label or its fix format; everything else is a Story.
- **Role.** A **task** is one piece of work an agent finishes in one session; it has no sub-issues. An **epic** is a set of tasks (its sub-issues) that ship together in one pull request, once every task is done. A **feature** groups epics; nobody builds a feature directly. A task with no epic is a **standalone task**, and counts as an epic of one.
- What an agent builds against is the task and its epic, never a planning document. Outcomes and success measures belong in planning documents, not in epics or tasks.

### Epic format

An epic's description has these sections, in this order, each as a plain `##` heading. Leave out `## Design` and `## Technical notes` when there is nothing to say; the others are always present.
- `## Problem`: who has the problem, what it is today and why it matters now.
- `## Scope`: what the epic delivers under `### In` and what it deliberately leaves out under `### Out`. Only what is really out of scope goes under Out: never relabel requested work as later or optional; if part of it truly is optional, ask a person.
- `## Design` (optional): UI and UX decisions, flows, components to reuse.
- `## Technical notes` (optional): constraints, integration points, real file paths, patterns to follow.
- `## Requirements`: the numbered requirements (see Requirement wording). Every requirement is owned by at least one story.

Nothing else: no title heading (the title is its own field), no checklist, no other sections. The repo decides which checks run on every task, so an epic never lists commands to run.

```markdown
## Problem

[Who has the problem, what it is today and why it matters now.]

## Scope

### In

- [What this epic delivers]

### Out

- [What it deliberately leaves out]

## Design

[Optional: UI and UX decisions, flows, components to reuse.]

## Technical notes

[Optional: constraints, integration points, file paths, patterns to follow.]

## Requirements

- FR-1: The system must [behavior].
- FR-2: WHEN [event or state], the system must [behavior].
- FR-3: IF [unwanted condition], the system must [behavior].
```

### Story format

A story is a task for new work. Its description is exactly this shape:
- One sentence: "As a [user], I want [capability] so that [benefit]."
- A `Covers:` line naming the requirements of its epic the story owns, by identifier (`Covers: FR-2, FR-4`). A standalone story has no epic, and no `Covers:` line.
- Optionally, short context: files to touch, patterns to follow.
- `## Acceptance Criteria` (exactly that, no trailing colon), a `- [ ]` checklist, as the last section.

Don't repeat the title as a heading, and don't add identifiers, priority, dependency or metadata lines: those are Linear fields. Never refer to another story by a drafting label such as US-001.

```markdown
As a [user], I want [capability] so that [benefit].

Covers: FR-1, FR-3

[Optional context: files to touch, patterns to follow.]

## Acceptance Criteria

- [ ] [Evidence to check]
- [ ] [More evidence to check]
```

### Fix format

A fix is a task for a bug. Its description has these sections, in this order, each always present:
- `## Current behavior`: what happens now, with the steps, input or state that show it.
- `## Expected behavior`: what must happen instead.
- `## Unchanged behavior`: the nearby behavior the fix must keep exactly as it is, so the fix doesn't break it.
- `## Acceptance Criteria`: a `- [ ]` checklist, as the last section.

A fix in an epic may add a `Covers:` line before `## Current behavior` when it owns requirements of the epic.

```markdown
## Current behavior

[What happens now, with the steps or input that show it.]

## Expected behavior

[What must happen instead.]

## Unchanged behavior

[Nearby behavior the fix must keep exactly as it is.]

## Acceptance Criteria

- [ ] [Evidence to check]
- [ ] [More evidence to check]
```

### Requirement wording

Requirements are a bullet list, numbered from 1: `- FR-1: The system must …`. Never headings.
- One behavior per requirement, explicit and unambiguous, stated as what the system must do.
- Add a condition only to conditional behavior: WHEN for an event or state (`- FR-2: WHEN a run fails, the system must …`), IF for an unwanted condition (`- FR-3: IF the token has expired, the system must …`). Behavior that always holds has no condition.
- Stories name the requirements they own by identifier in their `Covers:` line, so keep identifiers stable once stories refer to them.

### Checkable criteria

Acceptance criteria are evidence to check, not tests to write. Each one names something an agent can confirm inside the repo, in the code, the output of a command or the behavior of the running software: "Deleting a project asks for confirmation first", not "Works correctly".
- Tests are written where the repo's conventions call for them on new behavior, never to prove a criterion. Don't phrase a criterion as a test to add.
- A fix adds a regression test only where the affected code already has tests.
- No outcomes or metrics: nothing measured after merge, such as adoption, a percentage improvement, fewer support requests or user satisfaction. Those belong in planning documents.
- Nothing that needs human judgement, production access or an outside account.

### Sizing

Size the whole body of work, not one piece of it: XS, S, M, L or XL. Weigh the number of distinct requirements, the surface it touches (database, API, UI, integrations, infrastructure), the unknowns and risk, and how many focused agent sessions it would realistically take.
- **L or larger (L, XL): an epic.** One task per story or fix, and no validation task: the epic audit checks the requirements.
- **Smaller than L (XS, S, M): a single task.** One story, or one fix when it is a bug, with its acceptance criteria in its own description and no sub-issues.

### Splitting into tasks

Each task is built in one fresh, unattended agent session, so it must be small enough to finish in one.
- Split by feature boundary, never by development phase: "Sign-in" is one story, not scaffolding, logic, tests and polish as four.
- The tests, error handling, hardening and documentation of new code belong in the task that adds the code, never in a task of their own.
- Order the tasks so earlier ones enable later ones, and block a task only on the tasks it really depends on.
- Every task is in scope for the epic, and every requirement is owned by at least one task.
- A step only a person can do (credentials, DNS, third-party consoles, a migration run by operations, a design sign-off) is its own manual task, never a criterion on an agent's task.

### Epic audit

When every task of an epic is done, Omniralph audits the epic against its requirements before its pull request opens: it checks each requirement against the code, and files each gap it finds as a new task in the epic. So an epic carries only real work:
- Plan no validation or audit task (no `Validate functional requirements` task). Keep the epic's requirements in its description, where the audit reads them.
- An epic that already has a `Validate functional requirements` task keeps it: it still runs as a task, and the epic is audited too.

### Dependency rules

A "blocks" relation is the only thing that stops work from starting early, and Omniralph ships an epic only once every task in it is done. So:
- A task in an epic may be blocked only by another epic, a standalone task, or a task in its own epic.
- An epic may be blocked only by another epic or a standalone task.
- A standalone task counts as an epic of one.
- Nothing is blocked by a feature: block on the epic inside it the work waits for.
- When work waits for a task in another epic, block it on that task's epic instead.
- A task is never blocked by its own epic, and an epic never by one of its own tasks.
- Work found while building an epic that can't land until the epic ships becomes a standalone task blocked by the epic, never a blocker of the task that found it.

---

## Drafting tasks with the user

**Drafting labels.** While drafting with the user, refer to tasks as US-001,
US-002, … so dependencies are easy to discuss. These labels are for the
conversation only: they never go into Linear titles or bodies. Once
the sub-issues exist, their Linear identifiers (e.g. `ENG-12`) are
the task names: Omniralph uses them in plans, prompts and commit messages
(`feat(ENG-12): Add priority field to database`).

**Present each task as:**

```
US-001 — Add priority field to database
Kind: Story · Covers: FR-1 · Priority: High · Blocked by: — · Manual: no

As a developer, I want to store task priority in the database so that it
persists across sessions.

Acceptance criteria:
- [ ] ...
```

**Sub-issue title:** the plain task title. No `US-001:` prefix.

**Order and priority.** Omniralph picks the next task that has no open
blockers: in-progress tasks first, then by **Linear priority** (Urgent
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
label (or the label `LINEAR.md` names), wired with blocks relations
like any other task. Omniralph never works it; tasks that depend on it wait
until a person moves it to Done.

**Writing quality.** Each task is built by an AI coding agent in one fresh
session, so be explicit and unambiguous, include specific file paths when you
know them, and reference existing patterns in the repo.

---

## Linear structure reference

When you write to Linear (the exact create-or-update actions are in
each mode file), the target structure is one of:

**Epic (L or larger):**

- A parent issue whose description is the epic, plus the branch line (and a
  repo tag, if the user asked for one).
- One sub-issue per task, created **in task order**, each with:
  - `parentId` = the epic, `title` = the plain task title, `description` =
    the task in the story or fix format;
  - `priority` (1 Urgent, 2 High, 3 Medium, 4 Low), always set;
  - `blockedBy` = the tasks (and any work items outside the epic) it depends
    on, as the dependency rules allow;
  - the **manual** label (`addLabels`) for steps for a person.
- No validation sub-issue: Omniralph audits the epic against its
  requirements before its pull request opens.
- If the epic as a whole waits on other work, make the **epic** `blockedBy`
  it: Omniralph won't start any task until it's done.

After creating them:

1. Replace drafting labels with Linear identifiers wherever they ended
   up in a description.
2. Verify every dependency you drafted exists as a blocks relation.

**Single task (smaller than L):**

- One issue whose description is a story, or a fix for a bug, with no
  `Covers:` line, plus the branch line. No sub-issues.
- Omniralph builds the whole description as one task, and would split it into
  sub-issues if it looked like an epic. So in a single task: no requirement
  list, no task-style headings such as `### US-001: …`, and
  `## Acceptance Criteria` is the last section.
- Set `blockedBy` for any work item it waits on, as for an epic.

Whenever removing a task in Linear, **cancel** it (do not delete).
Never modify a sub-issue that is already completed or in progress, and never
restructure an issue, without explicit user confirmation.

### Routing and branch lines

Omniralph routes an issue to a repo by its **team, project or label**,
configured per repo in Omniralph. Expect that routing to be in place, and put
the issue in the team or project (or give it the label) that routes it.

- **Repo tag (only when asked).** Don't add a `[repo=…]` tag unless the user
  asks for one. A tag overrides the routing: an issue tagged with a repo that
  doesn't have Omniralph enabled isn't routed at all. When asked, add
  `[repo=<full path>]` on its own line, with the repo's full path
  (`acme/app`, `group/subgroup/project`). One repo per tag, and no branch in
  it.
- **Branch (optional).** If the user wants a specific branch name, add
  ``> Branch: `name` `` on its own line after the sections. Otherwise
  Omniralph uses Linear's branch name for the issue.

### Delegating to Omniralph

Delegating is what starts the run, and it's the user's call. Never offer to
delegate, and don't suggest it as a next step. Only if the user asks, delegate
the epic (or single task) with `save_issue` and `delegate`, using the agent
name from `LINEAR.md`, else `Omniralph`.

---

## Worked example

An epic of size L, titled `Task priorities`:

```markdown
## Problem

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

- Reuse the badge component in `src/components/badge.tsx` with its color variants.
- Keep filter state in the URL search params, like the status filter.

## Requirements

- FR-1: The system must store a priority of high, medium or low on every task, medium by default.
- FR-2: The system must show each task's priority as a colored badge on its card.
- FR-3: WHEN a user picks a priority filter, the system must list only the tasks with that priority.
- FR-4: IF a task is saved with a priority outside high, medium or low, the system must reject it.
```

One of its stories, titled `Show priority on task cards`, priority High,
blocked by the story that stores the priority:

```markdown
As a user, I want to see each task's priority at a glance so that I know what needs attention first.

Covers: FR-2

The badge component is `src/components/badge.tsx`; task cards are in `src/tasks/card.tsx`.

## Acceptance Criteria

- [ ] Each task card shows a priority badge: red for high, yellow for medium, gray for low
- [ ] The badge is visible without hovering or clicking
- [ ] A task without a stored priority shows the medium badge
```

A fix filed in the same epic, titled `Sort priorities by rank, not by name`:

```markdown
## Current behavior

Sorting the task list by priority puts low before medium: the sort compares the priority names alphabetically.

## Expected behavior

Sorting by priority orders tasks high, then medium, then low, within each status column.

## Unchanged behavior

Sorting by due date and by title orders tasks as it does today, and the sort choice stays in the URL.

## Acceptance Criteria

- [ ] With one task of each priority, sorting by priority lists them high, medium, low
- [ ] Sorting by due date and by title gives the same order as before
- [ ] Reloading the page keeps the chosen sort
```

There is no validation task: Omniralph audits FR-1 to FR-4 before the epic's
pull request opens.
