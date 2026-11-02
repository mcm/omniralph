<!-- Generated from the omniralph repo (packages/planning/src/plugin, built by scripts/build-prd-plugin.ts). Do not edit by hand: change it in the omniralph repo, and CI publishes it here. -->

# Mode: edit

You are revising an existing epic or single task. It may not follow the
planning formats yet: part of your job is to bring it to them during the edit
(subject to the user's preference below).

Follow the planning rules in `common.md`.

---

## Step 1: Load the existing work

Before doing anything else, use the Linear MCP tools to fetch the
issue and all of its sub-issues.

- Read the epic's (or the task's) full description.
- Enumerate every sub-issue, including a legacy `Validate functional
  requirements` task if one exists.
- Note each sub-issue's identifier, title, description, status, priority,
  labels (especially the manual label), and blocking relations.
- Note any sub-issues already completed, in progress, or cancelled: these
  constrain what can change.
- Check whether the epic is delegated to Omniralph or has an active agent
  session. If it does, Omniralph may be working a task right now.
- Look for an older format: a description with Introduction, Goals or
  Non-Goals sections, lists of metrics or of commands to run, stories as
  `### US-001: …` headings, `US-001:` title prefixes,
  `## Ralph Metadata` sections (Story ID, Ralph Priority, Dependencies), and
  tasks written as a story sentence ("As a … I want …") with a `Covers:`
  line and an `## Acceptance Criteria` checklist, or as
  `## Current behavior` / `## Expected behavior` /
  `## Unchanged behavior` sections.

Then summarize for the user:

- The work item's current shape (sections present, sections missing, and how
  it differs from the formats, including any older markup).
- Whether Omniralph is running on the epic. If it is, warn that the
  in-progress task is mid-run, and that changes are picked up by replying in
  the Omniralph session or by re-delegating.
- The tasks that exist today, in order.
- Whether a legacy validation task exists (it still runs as a task; new epics
  don't get one, since Omniralph audits each epic before its pull request).
- The current state of each sub-issue (completed tasks cannot be meaningfully
  edited; in-progress tasks should be flagged before changing).

This anchors the conversation: the user may not remember the exact current
state.

## Step 2: Clarifying questions

Ask 3–5 essential clarifying questions about the requested edits. Focus on:

- **Edit intent:** What is changing and why? Scope change, correction,
  clarification, or pivot?
- **Affected tasks:** Which existing tasks are impacted? Any to add, remove,
  or merge?
- **Work already done:** Are completed or in-progress tasks off-limits?
- **Format:** If the work item isn't in the planning formats, should it be
  rewritten in them as part of this edit, or left as it is to minimize churn?

Use lettered options and adaptive questioning (see `common.md`), fewer rounds
if the edit is small and well-specified. Example starter set:

```
1. What is the primary nature of this edit?
   A. Scope expansion: adding new behavior
   B. Scope reduction: removing behavior
   C. Correction: fixing errors or unclear requirements
   D. Pivot: fundamentally changing the approach
   E. Format only: no change in behavior
   F. Other: [please specify]

2. How should completed or in-progress sub-issues be handled?
   A. Leave them untouched; only edit pending tasks
   B. Edit pending tasks and append new ones; touch nothing already started
   C. Reopen and revise specific tasks (specify which)
   D. Other: [please specify]

3. Should the work item be rewritten in the planning formats?
   A. Yes, fully, even if it means rewriting prose
   B. Partly: only the sections being edited
   C. No, keep the existing structure
```

If the user picks 2C, warn them: reopening a Done task makes Omniralph run it
again on the next delegation, on top of code that is already on the epic
branch. Its acceptance criteria should describe the change still needed, not
the whole task again.

When rewriting an older format, map it onto the epic format: the introduction
becomes `## Problem`, goals and non-goals become `### In` and `### Out`
under `## Scope`, design and technical considerations become `## Design` and
`## Technical notes`, and the functional requirements become
`## Requirements`. Drop lists of commands to run and of metrics: the repo
decides the checks, and outcomes belong in planning documents.

When rewriting a task in an older format, map it onto the task format: the
story sentence (or the current and expected behavior of a fix) becomes the
"I want you to" paragraph, its notes on how to build it the "Build it by"
paragraph, and its acceptance criteria (with the unchanged behavior of a fix)
the "Don't stop until" paragraph. Drop its `Covers:` line.

## Step 3: Write the revised work item

After incorporating the user's answers, write the revised epic or task in the
planning formats (subject to the format preference from Step 2), adding
missing sections.

Also add a **Change Log** section (cumulative: keep any prior entries) at the
end of an epic, before the branch line:

```markdown
## Change Log

- What changed (sections, tasks, requirements)
- What is unchanged
- Any sub-issues closed, reopened, added, or whose dependencies shifted
```

Refer to tasks in the Change Log by Linear identifier. A single task
has no Change Log section: it stays three paragraphs, so give the user the
change summary in the conversation instead.

## Step 4: Re-size the work

Apply the Sizing rule from `common.md`, then compare against the issue's
current structure:

- Already an epic and still **L or larger**: keep the epic.
- Currently a single task but grown to **L or larger**: recommend turning it
  into an epic, but confirm before restructuring.
- Currently an epic but shrunk below **L**: tell the user. Collapsing an epic
  into a single task is a significant change that must be confirmed, and you
  must never collapse sub-issues that are already completed or in progress.

## Step 5: Reconcile tasks (if the issue is or stays an epic)

Reconcile the existing tasks with the requested edits. For each task, decide:
**Keep as-is**, **Edit**, **Add**, **Remove** (only if not yet started;
otherwise flag), or **Reorder**. Present the reconciliation explicitly:

```
ENG-12: Keep as-is
ENG-13: Edit (new acceptance criterion for empty state)
ENG-14: Remove (superseded by new-2)
ENG-15: Keep as-is
new-1:  Add (blocked by ENG-13)
new-2:  Add (blocked by ENG-15)
```

Guidelines:

- Existing tasks are named by their Linear identifier, which never
  changes: Omniralph's commits and progress log reference it. Label new tasks
  `new-1`, `new-2`, … until they are created.
- Each edited or new task follows the task format, with a priority, blocks
  relations, and the manual label or the bug label where it applies.
- **Older markup** (if the user chose to rewrite): remove `## Ralph Metadata`
  sections and `US-001:` title prefixes from pending tasks only. Omniralph
  uses a legacy `Ralph Priority` when a sub-issue has no Linear
  priority, so set the Linear priority first. Leave completed and
  in-progress tasks untouched.
- Don't add a validation task. A legacy one is kept as a task; if it is
  labelled manual, explain that Omniralph opens the pull request only once
  every task is done (unless the repo sets `openPullRequestEarly`), and ask
  whether to keep it that way.

## Step 6: Update the requirements

Update the numbered requirements. Keep the numbers of unchanged requirements;
append new ones at the end rather than renumbering, so references to them
stay valid.

- "FR-2: WHEN a user clicks X, the system must..." (edited: was about Y)
- "FR-7: [new requirement]"

If a requirement is being removed, mark it removed rather than deleting the
number:

- "FR-3: ~~[original text]~~ (removed in this revision)"

## Final step: apply changes in Linear

Present a diff-style summary to the user: sections that changed; tasks kept,
edited, added, removed or reordered; requirements added, edited or removed. If
your re-sizing crosses the **L** threshold relative to the current structure,
also summarize the proposed restructuring and get explicit confirmation before
applying it.

Have the user review and confirm before touching Linear. Only after
they confirm, use the Linear MCP tools:

- Update the issue's description with the revised epic or task.

**If the issue stays (or becomes) an epic, L or larger:**

- Per task: **Keep**, no action; **Edit**, update the sub-issue's title and
  description; **Add**, create a new sub-issue (see `common.md` →
  "Linear structure reference") with its priority, `blockedBy`
  dependencies and labels; **Remove**, cancel the sub-issue (do not delete)
  and note it in the Change Log; **Reorder**, update blocks relations
  (`blockedBy` / `removeBlockedBy`) and priorities to reflect the new
  order. Blocks relations carry the order; the sub-issue order in the parent
  is cosmetic, so don't mention it to the user.
- Replace any `new-N` labels in descriptions with the new Linear
  identifiers.
- If the epic has a legacy validation task, update it to list the revised
  requirements, and make sure it is blocked by every new task too.
- If a single task is being turned into an epic, create the tasks as in the
  `new` and `triage` final steps, with no validation task.

**If the issue stays (or becomes) a single task, smaller than L:**

- Keep it in the task format: its done criteria in the "Don't stop until"
  paragraph, last.
- Do not create new sub-issues. If the user confirmed collapsing an existing
  epic, fold the remaining sub-issues' content into the description and cancel
  (do not delete) those sub-issues, but never collapse a sub-issue that is
  already completed or in progress.

Never modify a sub-issue that is already completed, or restructure the issue,
without explicit user confirmation in this session.

## Checklist before applying changes

- [ ] Loaded and summarized the existing work for the user
- [ ] Asked clarifying questions with lettered options
- [ ] Incorporated the user's answers into the revised work item
- [ ] Reconciled every existing task (keep / edit / add / remove / reorder)
- [ ] Kept requirement numbers; referred to tasks by Linear identifier
- [ ] Sized the whole body of work and chose the structure accordingly
      (an epic only if L or larger)
- [ ] The epic has `## Problem`, `## Scope` (`### In` / `### Out`) and
      `## Requirements`, and nothing else besides the optional design and
      technical notes
- [ ] Every task, a single one or an epic's, is three paragraphs ("I want you
      to …", "Build it by …", "Don't stop until …") and nothing else: no
      `Covers:` line, story sentence, behavior sections or checklist heading
- [ ] Every constraint that must hold is in the "Don't stop until" paragraph,
      not in "Build it by"
- [ ] A fix has the bug label; a story doesn't
- [ ] Requirements are numbered `FR-n` bullets, one behavior each, with WHEN
      or IF only for conditional behavior
- [ ] Every requirement is built by at least one task
- [ ] Tasks split by feature, not by phase, each small enough for one session
- [ ] Full scope stated up front; nothing labelled future/stretch/v2 unless the
      user did, and genuinely optional items were put to the user
- [ ] Acceptance criteria are evidence an agent can check inside the repo, not
      tests to write, and no outcome or metric measured after merge
- [ ] No commands for every task to run written into any description
- [ ] Steps for a person are separate manual tasks
- [ ] Every task has a priority, and its dependencies as blocks relations the
      dependency rules allow; no drafting labels or metadata in titles or bodies
- [ ] An epic has no validation task: Omniralph audits its requirements
      before its pull request opens
- [ ] The issue is in the team or project (or has the label) that routes it; no
      `[repo=…]` tag unless the user asked for one
- [ ] No `## Open Questions` section left in any description
- [ ] Warned the user if Omniralph is running on the epic or a Done task is
      being reopened
- [ ] Change Log entry written
- [ ] Did not silently modify completed or in-progress sub-issues, or
      restructure the issue without confirmation

Once the changes are applied, if Omniralph is running on the epic, tell the
user it picks them up from a reply in its session. Then tell the user you're
done. Don't offer to delegate or re-delegate the epic.
