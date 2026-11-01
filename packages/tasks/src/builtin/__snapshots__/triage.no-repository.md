Triage the Linear issue OPS-1 into a PRD that Omniralph can build.

## The issue
- Identifier: OPS-1
- State type: `triage`

<issue-title>
(empty)
</issue-title>

<issue-description>
(empty)
</issue-description>

## Comments
None.

## Sub-issues
None.

## Repository
No repository is routed to this issue, so there is no checkout: keep file paths generic, and add an open question asking which repository the work belongs in (quality gates and file paths become specific once it is known).

## How to triage

The PRDs you write are executed by Omniralph, an agent that runs each sub-issue (or a single issue) as one fresh, unattended AI coding session: it runs the quality gates, commits, marks the story done and moves on, and opens the pull request when every story is done. Precision and machine-verifiable acceptance criteria matter. Omniralph reads stories from Linear's own fields (identifier, title, priority, sub-issue order, state, labels, "blocks" relations) plus the checkboxes in each description, never from story IDs or metadata in titles or bodies.

### 1. Understand the issue
- Read the title, description, comments, sub-issues and blockers below. Work out what is already specified, what you can infer about intent, and what is missing relative to the PRD format.
- If a repository is checked out, read it targeted, not wholesale: CI config and package scripts for the quality gates, the files the feature touches for technical considerations, existing components and patterns to reuse. Cite real file paths.
- If the repository has a `LINEAR.md` at its root, read it first and honour it throughout: it holds the project's conventions for Linear issues (e.g. whether to add a `> Branch:` line, the manual label, standard manual stories).

### 2. Decide what kind of triage this is (`outcome`)
- `prd`: the issue isn't a PRD yet (a one-liner, a bug report, loose notes, a partial spec) and has no sub-issues. Write the full PRD; if it is L or larger, also the stories.
- `reformat`: the issue is already planned (it has sub-issues) but isn't in the format below. Reformat it, don't replan it: keep its scope, decisions, stories and their order, and fix the format of the description and of every Backlog/Todo sub-issue (`subIssueUpdates`). Never add new stories alongside existing sub-issues (`stories` stays empty), and never drop, merge or cancel sub-issues; if work seems to be missing, or a sub-issue seems wrong or redundant, say so in an open question.
- `unchanged`: the issue is already a PRD in the format below and needs no rewrite. Return its current description (without any `## Open Questions` section) and title as they are, with no stories or sub-issue updates.
- An issue whose description holds user stories but has no sub-issues (e.g. a `### US-001: …` PRD) is `prd`: rewrite it in this format, with its stories as `stories` when it is L or larger.
- Omniralph never touches work in progress: only sub-issues in state type `backlog` or `unstarted` can be updated.

### 3. Write the PRD (`description`)
The description becomes the issue's description, and Omniralph includes it in every story's prompt. Use these sections, in this order, each as a plain `##` heading (`## Goals`, not `## 2. Goals`); the optional ones only when there is something to say:
1. `## Introduction`: what the feature is and the problem it solves.
2. `## Goals`: specific, measurable objectives (bullets).
3. `## Quality Gates`: the commands every story must pass (see below). Always present.
4. `## Non-Goals`: what this will NOT include. Only what is really out of scope: never label part of the requested work "future enhancement", "stretch" or "v2" unless the issue does. If something is genuinely optional, ask about it in an open question so a person decides; never defer it silently.
5. `## Design Considerations` (optional): UI/UX requirements, mockups, components to reuse.
6. `## Technical Considerations` (optional): constraints, dependencies, integration points, file paths.
7. `## Success Metrics`: how you will know it succeeded (bullets, measurable).
8. `## Functional Requirements`: a numbered list of bullets (`- FR-1: The system must …`). Explicit and unambiguous; never headings.
9. Single issues only (smaller than L): `## Acceptance Criteria`, a consolidated `- [ ]` checklist, as the very last section.

Don't write a `# Title` heading (the title is its own field), a `## Description` or `## Test Plan` heading, or a `## Open Questions` section: report open questions in `openQuestions` and Omniralph adds the section at the end.

Branch line: by default add none. Add ``> Branch: `name` `` on its own line after the sections only when the issue or `LINEAR.md` asks for it (keep one that is already there). Never add a `[repo=…]` tag: repositories are routed by their settings, not by the description.

#### Quality Gates
Omniralph finds the gates by exact format, so follow it exactly:
- The heading is literally `## Quality Gates`.
- Each command is its own bullet, and the command is the **first backticked span** of the bullet: ``- `pnpm lint` - Linting``.
- Anything that isn't a shell command must not start with backticks (a bullet like ``- `dev-browser` skill`` would be run as a command): write it as a plain prose bullet.
- Every command must be non-interactive (no watch mode, no prompts) and runnable from the repository root in a fresh checkout.

```
## Quality Gates

These commands must pass for every user story:
- `pnpm typecheck` - Type checking
- `pnpm lint` - Linting
- `pnpm test` - Unit tests
```

Discover them from the repository, in this order:
1. **CI config first** (`.github/workflows/*.yml`, `.gitlab-ci.yml` or equivalent): take the commands the pull-request pipeline runs (lint, typecheck, test, build). Gates weaker than CI let every story pass and then fail at the end, because CI only runs once the finished epic's pull request opens.
2. **Then the scripts those commands call** (`package.json` scripts, `Makefile`, `pyproject.toml`, …). Prefer an aggregate script when CI uses one.
Don't add browser verification unless the issue or `LINEAR.md` says the coding host has a browser tool. Without a repository, keep the heading with a prose bullet saying the gates are still to be decided, and add an open question asking which repository and commands apply.

### 4. Size it (`size`)
Estimate the size of the entire body of work (every goal and functional requirement, not one piece): the number of distinct requirements, the surface area touched (database, API, UI, integrations, infra), unknowns and risk, and how many focused AI-agent sessions it would realistically take. XS, S, M, L or XL. Then apply the rule:
- **L or larger (L, XL) → an epic**: one sub-issue per user story plus a final validation sub-issue.
- **Smaller than L (XS, S, M) → a single self-contained issue**: no stories, acceptance criteria in the description.
Mention the size and a one-line rationale in your summary. For `reformat` and `unchanged`, size the work as planned.

### 5. Stories (`stories`; `prd` epics only, L or larger)
Each story becomes one sub-issue, implemented in one fresh unattended session, so it must be small enough to finish in one session. Order them so earlier ones enable later ones. Split by feature boundary, never by development phase: "Auth system" is one story, not scaffolding, logic, tests and polish as four. Every story is in scope for the goal.
- `title`: the plain story title. No `US-001:` prefix or other IDs.
- `body`: exactly this shape, nothing else:

```
As a [user], I want [feature] so that [benefit].

[Optional extra context: files to touch, patterns to follow.]

## Acceptance Criteria

- [ ] Specific verifiable criterion
- [ ] Another criterion
```

  Don't repeat the title as a heading, and don't add a `## Ralph Metadata` section, story IDs, priority or dependency lines: those are Linear fields. The heading is exactly `## Acceptance Criteria` (no trailing colon). Never refer to other stories by drafting labels like US-001.
- `priority`: 1 Urgent, 2 High, 3 Medium, 4 Low. Priority beats order when Omniralph picks the next story, so use one priority for the whole epic, or priorities that agree with the order on purpose.
- `dependsOn`: the 0-based indexes, in `stories`, of the stories it really depends on. These become "blocks" relations, the only thing that stops a story from running early.
- `manual`: true for a step only a person can do (secrets or credentials, DNS, third-party consoles, data migrations run by ops, design sign-off). Such steps are their own stories, never acceptance criteria on an agent story.
- Every acceptance criterion must be verifiable by the agent itself, inside the repository: nothing that needs human judgement, production access or an external account. "Works correctly" is bad; "Button shows a confirmation dialog before deleting" is good.
- Tests, error handling and basic hardening belong in the acceptance criteria of the story that introduces the code, never in a story of their own. The same goes for documenting that code.
- The **last** story is the validation sub-issue, titled `Validate functional requirements`, depending on every other story, with this body:

```
Verify that the finished epic meets every functional requirement and every story's acceptance criteria. For each item, confirm it in the code or with a test; add missing tests and fix any gap you find.

## Acceptance Criteria

- [ ] FR-1: …
- [ ] FR-2: …
- [ ] All acceptance criteria of the other stories of this epic are met
- [ ] All quality gates pass
```

The epic's description is the PRD (sections above, without `## Acceptance Criteria`); the stories go in `stories` only, never into the description.

### 6. Single issues (smaller than L)
Omniralph treats the whole description as one story, and would split it into sub-issues if it looked like a PRD with stories. So:
- no story-style headings such as `### US-001: …`, `### FR-1: …` or `### Feature 1.1: …`: functional requirements are bullets and criteria are checkboxes;
- no ```json block containing `userStories`;
- `## Acceptance Criteria` is the last section.
`stories` and `subIssueUpdates` stay empty.

### 7. Reformatting sub-issues (`subIssueUpdates`; `reformat` only)
For each sub-issue in state type `backlog` or `unstarted` that isn't in the story format above, add an entry with its `id` (as given below), its title without ID prefixes, its body in the story format (keep its intent and criteria; drop `## Ralph Metadata`, story IDs, priority and dependency lines, and turn criteria into a `## Acceptance Criteria` checklist), its `priority` (1–4; keep the current one unless it has none) and `blockedBy` (the `id`s of the sibling sub-issues it depends on, and the identifiers of work items outside this issue it is blocked by, including the existing relations under Blocked by; Omniralph blocks it on a task's epic when that task is in another epic). Leave out sub-issues that are already fine and every sub-issue in any other state.

### 8. Open questions (`openQuestions`)
You can't ask anyone during the session. Answer what you can from the issue, comments, sub-issues, blockers and source, and make reasonable, conventional choices for minor details (mention notable ones under Technical Considerations). Every ambiguity that remains and would change the scope, the behaviour, the acceptance criteria or the structure becomes one open question: specific, self-contained, and answerable in a sentence, with lettered options when that helps (e.g. "Who can delete a project? A. Owners only B. Owners and admins"). Don't ask about anything the issue already answers. Leave `openQuestions` empty when nothing is left: the issue then moves to Todo, ready for Omniralph. With open questions it stays in Backlog and Omniralph won't start it until they are answered.
- A description that already ends with a `## Open Questions` section holds the questions of an earlier triage: fold the answers given in the comments or the reply into the PRD, and keep only the questions still unanswered.

### 9. Summary (`summary`)
A few lines for the thread on Linear: the outcome, the size and why, the structure (single issue, epic with N stories, or which sub-issues were reformatted), and how many open questions remain.

## Triage this issue
1. Study the issue, its comments and sub-issues, and the repository (CI config and `LINEAR.md` first).
2. Decide the outcome, write or reformat the PRD, size it, and write the stories or sub-issue updates the structure needs.
3. Turn every remaining ambiguity into an open question.
4. Report the result in your structured output: `outcome`, `title`, `description`, `size`, `openQuestions`, `stories`, `subIssueUpdates` and `summary`.