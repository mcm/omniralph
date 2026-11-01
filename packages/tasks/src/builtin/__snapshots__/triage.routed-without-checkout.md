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
- The **last** entry is the validation audit, titled `Validate functional requirements`, depending on every other entry. Its body is the validation audit; Omniralph writes it from the epic's requirements, whatever you put there.

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
- **L or larger (L, XL): an epic.** One task per story or fix, then the validation audit as the last task.
- **Smaller than L (XS, S, M): a single task.** One story, or one fix when it is a bug, with its acceptance criteria in its own description and no sub-issues.

### Splitting into tasks

Each task is built in one fresh, unattended agent session, so it must be small enough to finish in one.
- Split by feature boundary, never by development phase: "Sign-in" is one story, not scaffolding, logic, tests and polish as four.
- The tests, error handling, hardening and documentation of new code belong in the task that adds the code, never in a task of their own.
- Order the tasks so earlier ones enable later ones, and block a task only on the tasks it really depends on.
- Every task is in scope for the epic, and every requirement is owned by at least one task.
- A step only a person can do (credentials, DNS, third-party consoles, a migration run by operations, a design sign-off) is its own manual task, never a criterion on an agent's task.

### Validation audit

Every epic ends with a validation audit: its last task, titled `Validate functional requirements`, blocked by every other task in the epic. It has one criterion per requirement of the epic, copied as the epic words it, and this body:

```markdown
Audit the finished epic against its requirements. For each requirement below, find the evidence that it holds on the epic's branch: the code that implements it, and the tests the repo's conventions call for on that behavior. Check every story's acceptance criteria the same way. Fix each gap you find, as part of this task.

## Acceptance Criteria

- [ ] FR-1: [the requirement, as the epic words it]
- [ ] Every acceptance criterion of the other tasks in this epic holds
- [ ] The repo's checks pass
```

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