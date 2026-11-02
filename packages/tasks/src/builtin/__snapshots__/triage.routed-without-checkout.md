Triage the Linear issue ENG-42 into an epic, a story or a fix that Omniralph can build.

## The issue
- Identifier: ENG-42 (https://linear.app/acme/issue/ENG-42/csv-export)
- State type: `unstarted`

<issue-title>
CSV export
</issue-title>

<issue-description>
We need CSV export of widgets.
</issue-description>

## Comments
None.

## Sub-issues
None.

## Repository
No repository is routed to this issue, so there is no checkout: keep file paths generic, and add an open question asking which repo the work belongs in (file paths become specific once it is known).

## Your previous triage of this issue
This session triaged the issue before (outcome `prd`, size S). Build on it rather than starting over: keep what still holds and change only what the reply and any new information call for.

<previous-title>
Export widgets as CSV
</previous-title>
<previous-description>
PRD
</previous-description>
It had no open questions.

## How to triage

What you write is built by Omniralph, which runs each task as one fresh, unattended AI coding session: it runs the repo's checks, commits, marks the task done and moves on, and opens the pull request once every task in the epic is done. Precise, checkable acceptance criteria matter. Omniralph reads tasks from Linear's own fields (identifier, title, priority, sub-issue order, state, labels, "blocks" relations) plus the checkboxes in each description, never from identifiers or metadata written into titles or bodies.

### 1. Understand the issue

- Read the title, description, comments, sub-issues and blockers below. Work out what is already decided, what you can infer about intent, and what is missing.
- If a repo is checked out, read it targeted, not wholesale: the files the work touches, existing components and patterns to reuse. Cite real file paths in technical notes and context.
- If the repo has a `LINEAR.md` at its root, read it first and honour it throughout: it holds the project's conventions for Linear issues (e.g. whether to add a `> Branch:` line, the manual label, standard manual tasks).
- Decide whether the issue is a bug (a Fix) or new work (a Story).

### 2. Decide what kind of triage this is (`outcome`)

- `prd`: the issue has no sub-issues and isn't yet written in the formats below (a one-liner, a bug report, loose notes, a partial spec, or an older format). Write it out; if it is L or larger, also write its tasks.
- `reformat`: the issue is already planned (it has sub-issues) but isn't in the formats below. Reformat it, don't replan it: keep its scope, decisions, tasks and their order, and fix the format of the description and of every Backlog or Todo sub-issue (`subIssueUpdates`). Never add tasks beside existing sub-issues (`stories` stays empty), and never drop, merge or cancel sub-issues; if work seems missing, or a sub-issue seems wrong or redundant, say so in an open question.
- `unchanged`: the issue is already in the formats below and needs no rewrite. Return its current title and description as they are (without any `## Open Questions` section), with no tasks or sub-issue updates.
- An issue whose description holds user stories but has no sub-issues (e.g. a `### US-001: …` list) is `prd`: rewrite it, with its stories as tasks when it is L or larger.
- Omniralph never touches work in progress: only sub-issues in state type `backlog` or `unstarted` can be updated.

### 3. Write the description (`description`)

The description becomes the issue's description, and Omniralph shows it to the agent working each task. Size the work first (see Sizing), then write:
- **L or larger:** the epic format. The tasks go in `stories`, never into the description.
- **Smaller than L:** a single task, in the fix format when the issue is a bug and the story format otherwise, with no `Covers:` line. Omniralph builds the whole description as one task, so it has no requirement list, no story-style headings such as `### US-001: …`, and its `## Acceptance Criteria` is the last section.

Never write a `## Open Questions` section yourself: report open questions in `openQuestions` and Omniralph adds the section at the end.

Branch line: by default add none. Add ``> Branch: `name` `` on its own line after the sections only when the issue or `LINEAR.md` asks for it (keep one that is already there). Never add a `[repo=…]` tag: repos are routed by their settings, not by the description.

### 4. Report the size (`size`)

Report the size by the Sizing rule, and mention it with a one-line rationale in your summary. For `reformat` and `unchanged`, size the work as planned.

### 5. Write the tasks (`stories`; `prd` epics only, L or larger)

Each entry becomes one sub-issue of the epic, in the story or fix format, split by the Splitting rule.
- `title`: the plain task title, with no `US-001:` prefix or other identifiers.
- `body`: the description, in the story format (or the fix format for a bug in the epic).
- `priority`: 1 Urgent, 2 High, 3 Medium, 4 Low. Priority beats order when Omniralph picks the next task, so use one priority for the whole epic, or priorities that agree with the order on purpose.
- `dependsOn`: the 0-based indexes, in `stories`, of the tasks it really depends on. These become "blocks" relations.
- `manual`: true for a step only a person can do.
- No validation or audit entry (no `Validate functional requirements` task): Omniralph audits the epic against its requirements before its pull request opens, so every entry is real work.

### 6. Reformat sub-issues (`subIssueUpdates`; `reformat` only)

For each sub-issue in state type `backlog` or `unstarted` that isn't in the story or fix format, add an entry with its `id` (as given below), its title without identifier prefixes, its body in the story or fix format (keep its intent and criteria; drop metadata sections, identifiers, priority and dependency lines, and turn its criteria into a `## Acceptance Criteria` checklist), its `priority` (1–4; keep the current one unless it has none) and `blockedBy` (the `id`s of the sibling sub-issues it depends on, and the identifiers of work items outside this issue it is blocked by, including the existing relations under Blocked by; Omniralph applies the Dependency rules). Leave out sub-issues that are already fine and every sub-issue in any other state.

### 7. Open questions (`openQuestions`)

You can't ask anyone during the session. Answer what you can from the issue, comments, sub-issues, blockers and source, and make reasonable, conventional choices for minor details (mention notable ones under technical notes). Every ambiguity left that would change the scope, the behavior, the acceptance criteria or the structure becomes one open question: specific, self-contained and answerable in a sentence, with lettered options when that helps (e.g. "Who can delete a project? A. Owners only B. Owners and admins"). Don't ask about anything the issue already answers. Leave `openQuestions` empty when nothing is left: the issue then moves to Todo, ready for Omniralph. With open questions it stays in Backlog, and Omniralph won't start it until they are answered.
- A description that already ends with a `## Open Questions` section holds the questions of an earlier triage: fold the answers given in the comments or the reply into the description, and keep only the questions still unanswered.

### 8. Summary (`summary`)

A few lines for the thread on Linear: the outcome, the size and why, the structure (a single story or fix, an epic with N tasks, or which sub-issues were reformatted), and how many open questions remain.

## Planning rules

### Work items

Every work item has a kind and a role.
- **Kind.** A **Story** is new work or an enhancement. A **Fix** is a bug: something that should work and doesn't. Omniralph tells a Fix by its bug label; everything else is a Story. Both are written in the task format.
- **Role.** A **task** is one piece of work an agent finishes in one session; it has no sub-issues. An **epic** is a set of tasks (its sub-issues) that ship together in one pull request, once every task is done. A **feature** groups epics; nobody builds a feature directly. A task with no epic is a **standalone task**, and counts as an epic of one.
- What an agent builds against is the task and its epic, never a planning document. Outcomes and success measures belong in planning documents, not in epics or tasks.

### Epic format

An epic's description has these sections, in this order, each as a plain `##` heading. Leave out `## Design` and `## Technical notes` when there is nothing to say; the others are always present.
- `## Problem`: who has the problem, what it is today and why it matters now.
- `## Scope`: what the epic delivers under `### In` and what it deliberately leaves out under `### Out`. Only what is really out of scope goes under Out: never relabel requested work as later or optional; if part of it truly is optional, ask a person.
- `## Design` (optional): UI and UX decisions, flows, components to reuse.
- `## Technical notes` (optional): constraints, integration points, real file paths, patterns to follow.
- `## Requirements`: the numbered requirements (see Requirement wording). Every requirement is built by at least one task.

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

### Task format

A task's description is three paragraphs, in this order, each opening with its own words. Story and Fix are kinds of the same shape; a task is a Fix when it carries the bug label.
1. **`I want you to …`** What to build, in one paragraph. For a Story: build what the task delivers, for whom and why. For a Fix: fix what is broken, saying what happens now and what should happen instead.
2. **`Build it by …`** How to build it. For a Story: where the code lives, the patterns to follow and the files to touch. For a Fix: the likely cause of the bug and where the code lives.
3. **`Don't stop until …`** When it is done, as prose or a short list. For a Story: the done criteria the loop can check and every constraint that must hold. For a Fix: the fixed behavior, every constraint that must hold and the nearby behavior that must not change.

The agent building the task gets all three paragraphs, with the third as its stop condition. The agent verifying it gets only the first and third, with the change, so it judges the result rather than the approach.

Nothing else: no headings, no `Covers:` line, no checklist section. Don't repeat the title, and don't add identifiers, priority, dependency or metadata lines: those are Linear fields. Never refer to another task by a drafting label such as US-001.

```markdown
I want you to [Story: build what the task delivers, for whom and why. Fix: fix what is broken, saying what happens now and what should happen instead.]

Build it by [Story: where the code lives, the patterns to follow and the files to touch. Fix: the likely cause of the bug and where the code lives.]

Don't stop until [Story: the done criteria the loop can check and every constraint that must hold. Fix: the fixed behavior, every constraint that must hold and the nearby behavior that must not change.]:
- [A done criterion to check]
- [A constraint that must hold]
```

### Requirement wording

Requirements are a bullet list, numbered from 1: `- FR-1: The system must …`. Never headings.
- One behavior per requirement, explicit and unambiguous, stated as what the system must do.
- Add a condition only to conditional behavior: WHEN for an event or state (`- FR-2: WHEN a run fails, the system must …`), IF for an unwanted condition (`- FR-3: IF the token has expired, the system must …`). Behavior that always holds has no condition.
- Tasks don't name the requirements they build: the epic audit checks every requirement against the finished branch on its own. Keep identifiers stable all the same, since people and audits refer to them.

### Checkable criteria

A task's `Don't stop until` paragraph holds its done criteria: criteria the loop can check, each one evidence to check, not a test to write. Each one names something an agent can confirm inside the repo, in the code, the output of a command or the behavior of the running software: "Deleting a project asks for confirmation first", not "Works correctly".
- Tests are written where the repo's conventions call for them on new behavior, never to prove a criterion. Don't phrase a criterion as a test to add.
- A fix adds a regression test only where the affected code already has tests.
- No criterion is an outcome or metric: nothing measured after merge, such as adoption, a percentage improvement, fewer support requests or user satisfaction. Those belong in planning documents.
- Nothing that needs human judgement, production access or an outside account.

### Constraints and guidance

- Every constraint that must hold goes in the `Don't stop until` paragraph, never in the `Build it by` paragraph: no new table, never force-push, a behavior that must not change. The agent verifying the task never sees the second paragraph, so a constraint written there goes unchecked.
- The `Build it by` paragraph is guidance: where to look and how it would likely be built. The agent building the task may depart from it when the code shows a better way, so it holds nothing the task is judged by.

### Sizing

Size the whole body of work, not one piece of it: XS, S, M, L or XL. Weigh the number of distinct requirements, the surface it touches (database, API, UI, integrations, infrastructure), the unknowns and risk, and how many focused agent sessions it would realistically take.
- **L or larger (L, XL): an epic.** One task per story or fix, and no validation task: the epic audit checks the requirements.
- **Smaller than L (XS, S, M): a single task.** One task in the task format, a Fix when it is a bug, with its done criteria in its own description and no sub-issues.

### Splitting into tasks

Each task is built in one fresh, unattended agent session, so it must be small enough to finish in one.
- Split by feature boundary, never by development phase: "Sign-in" is one story, not scaffolding, logic, tests and polish as four.
- The tests, error handling, hardening and documentation of new code belong in the task that adds the code, never in a task of their own.
- Order the tasks so earlier ones enable later ones, and block a task only on the tasks it really depends on.
- Every task is in scope for the epic, and every requirement is built by at least one task.
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

## Triage this issue
1. Study the issue, its comments and sub-issues, and the repo (`LINEAR.md` first).
2. Decide the outcome and the kind (a Story or a Fix), size the work, write or reformat the epic, story or fix, and write the tasks or sub-issue updates the structure needs.
3. Turn every remaining ambiguity into an open question.
4. Report the result in your structured output: `outcome`, `title`, `description`, `size`, `openQuestions`, `stories`, `subIssueUpdates` and `summary`.