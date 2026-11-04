/**
 * The skill's modes (`new`, `triage`, `edit`, `ui-loop`, `prfaq`, `plan`): the
 * plugin-only, interactive step sequences. Each refers to the planning rules in
 * `common.md` by name instead of restating them; `prfaq` and `plan` carry the
 * planning-document rules they follow (`rules`), rendered after their steps.
 */
import {
  type FeatureDocumentKind,
  PLAN_EPICS_SECTION,
  PLAN_RULE,
  PRFAQ_RULE,
  SUCCESS_METRICS_RULE,
} from "../methodology/documents.js";
import type { Fragment } from "../methodology/rules.js";

/** A mode of the skill and its reference file. */
export interface PluginMode {
  /** The mode token, e.g. `new`. */
  id: string;
  /** The reference file's name, e.g. `mode-new.md`. */
  file: string;
  /** The file's Markdown, with `{{trackerName}}`/`{{conventionsFile}}` placeholders. */
  body: string;
  /** Methodology fragments the mode follows, rendered after its body as `##` sections. */
  rules?: readonly Fragment[];
}

/** The checks shared by every mode's checklist, before it writes to the tracker. */
const PLAN_CHECKLIST = `- [ ] Sized the whole body of work as a Fix, Story, Epic or Feature, stated
      the reason, and chose the structure accordingly (an epic only for an
      Epic; nothing filed for a Feature)
- [ ] The epic has \`## Problem\`, \`## Scope\` (\`### In\` / \`### Out\`) and
      \`## Requirements\`, and nothing else besides the optional design and
      technical notes
- [ ] Every task, a single one or an epic's, is three paragraphs ("I want you
      to …", "Build it by …", "Don't stop until …") and nothing else: no
      \`Covers:\` line, story sentence, behavior sections or checklist heading
- [ ] Every constraint that must hold is in the "Don't stop until" paragraph,
      not in "Build it by"
- [ ] A fix has the bug label; a story doesn't
- [ ] Requirements are numbered \`FR-n\` bullets, one behavior each, with WHEN
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
      \`[repo=…]\` tag unless the user asked for one
- [ ] No \`## Open Questions\` section left in any description`;

/** `new`: plan from scratch and create the issues. */
export const MODE_NEW: PluginMode = {
  id: "new",
  file: "mode-new.md",
  body: `# Mode: new

You are planning a piece of software work from scratch, then saving it to
{{trackerName}}.

Depending on its size (see the Sizing rule in \`common.md\`), it becomes a
single task (a **Fix** or a **Story**), an epic (an **Epic**: a {{trackerName}}
issue with one sub-issue per task), or nothing yet (a **Feature**: too big for
one epic, so you recommend planning it as a feature instead).

If the invocation included \`--project\` and/or \`--team\` hints, use them when
creating the issues. If a \`{{conventionsFile}}\` exists, honor its conventions.

Follow the planning rules in \`common.md\`.

---

## Step 1: Clarifying questions

Before writing anything, ask 3–5 essential clarifying questions where the
initial prompt is ambiguous. Focus on:

- **Problem:** Who has the problem, and why does it matter now?
- **Core behavior:** What must the system do? For a bug, what happens now and
  what should happen instead?
- **Scope:** What is in, and what should it NOT do?
- **Done:** What evidence shows each piece is finished?

Use lettered options and adaptive questioning (see \`common.md\`). Ask about
prerequisites and manual steps (see \`common.md\`).

## Step 2: Size the work

Apply the Sizing rule from \`common.md\`. State the size (Fix, Story, Epic or
Feature) with its t-shirt estimate, a one-to-two-sentence reason, and the
resulting structure (a single fix or story, an epic with sub-issues, or a
feature to plan) before continuing.

## Step 3: Write the work item

- **Fix or Story:** write a single task in the task format: its three
  paragraphs, framed as a fix for a bug and as a story otherwise.
- **Epic:** write the epic in the epic format, with its numbered requirements.
- **Feature:** don't write an epic. Tell the user it is too big for one pull
  request and recommend planning it as a feature, epic by epic. Give the
  reason and a first cut of the epics it splits into, in the order they would
  ship: a plain title and a sentence or two on what each delivers, split by
  what each delivers, never by development phase. Skip Step 4. If the user
  would rather start now, offer to plan just the first epic as its own work
  item (sized again with the Sizing rule) and continue with that. Otherwise
  offer to start the feature's PRFAQ (\`/omniralph-prd prfaq\`) or its Plan
  (\`/omniralph-prd plan\`) from what you've learned.

## Step 4: Tasks (Epic only)

Split the epic into tasks by the Splitting rule, each in the task format (a
fix for a bug, a story otherwise). Present them as \`common.md\` → "Drafting
tasks with the user" shows.
Don't add a validation task: Omniralph audits the epic against its
requirements before its pull request opens.

## Final step: save to {{trackerName}}

Once the work item (plus its tasks, if an **Epic**) is written, have the
user review and confirm it is ready to save. Only after they confirm, use the
{{trackerName}} MCP tools to create the issues, following \`common.md\` →
"{{trackerName}} structure reference":

**If an Epic, create an epic with sub-issues:**

- Create a new parent issue.
  - Give it a descriptive but concise title.
  - Use the epic (with the branch line, if any) as the description.
  - Set \`blockedBy\` for any work item the whole epic waits on.
- Create a sub-issue for each task, in task order.
  - Use the plain task title as the sub-issue title (no drafting label).
  - Use the task's three paragraphs as the description.
  - Set its priority, its \`blockedBy\` dependencies, the manual label for
    steps for a person, and the bug label for a fix.
- Do the post-creation steps: replace drafting labels with {{trackerName}}
  identifiers, and verify the blocks relations.

**If a Fix or a Story, create a single task (no sub-issues):**

- Create one new issue with a descriptive but concise title, the task's three
  paragraphs (with the branch line, if any) as its description, the bug label
  for a fix, and \`blockedBy\` for any work item it waits on.
- Do **not** create any sub-issues.

**If a Feature, create nothing** (unless the user chose to plan its first epic
on its own, which is then saved as above). Leave the recommendation and the
first cut of its epics with the user for feature planning.

## Checklist before creating the issues

- [ ] Asked clarifying questions with lettered options
- [ ] Incorporated the user's answers
${PLAN_CHECKLIST}

Once the issues are created, tell the user you're done.`,
};

/** `triage`: turn an existing rough issue into the planning formats. */
export const MODE_TRIAGE: PluginMode = {
  id: "triage",
  file: "mode-triage.md",
  body: `# Mode: triage

You are triaging an existing {{trackerName}} issue into the planning formats.
The issue is not yet planned: it may be a one-line description, a bug report,
a loose collection of thoughts, a feature request with partial detail, or an
older format. Your job is to elicit the missing context and write the full
structure back to the **same** issue.

Depending on its size (see the Sizing rule in \`common.md\`), the issue stays a
single task (a **Fix** or a **Story**), becomes an epic (an **Epic**, with one
sub-issue per task), or gets a recommendation to plan it as a feature (a
**Feature**: too big for one epic, so nothing is rewritten or filed).

Follow the planning rules in \`common.md\`.

---

## Step 1: Load and summarize the issue

Before asking anything, use the {{trackerName}} MCP tools to fetch the target
issue.

- Read the title, description, comments, labels, and any linked issues.
- Note the issue's current state, priority, and assignee.
- Decide whether it is a bug (a fix) or new work (a story), and identify what
  is already specified and what is missing relative to the formats.
- If the description has a \`## Open Questions\` section (Omniralph's automated
  triage writes one), those questions are gaps to resolve with the user. Fold
  the answers into the work item and drop the section: Omniralph won't start
  the issue while it has open questions.

Then summarize for the user:

- What the issue says today (a brief restatement, not a copy-paste).
- What you can infer about intent.
- The specific gaps to fill before it can be built (the problem, the scope,
  the expected behavior, checkable criteria, and so on).

This anchors the conversation and shows the user what's missing before you
ask.

## Step 2: Clarifying questions

Ask 3–5 essential clarifying questions targeted at the gaps you identified:

- **Problem:** Who has the problem, and why does it matter now?
- **Core behavior:** What must the system do? For a bug, what happens now,
  what should happen instead, and what must stay as it is?
- **Scope:** What is in, and what should it NOT do?
- **Done:** What evidence shows each piece is finished?

If the existing issue already answers some of these, don't re-ask: confirm your
understanding instead. Use lettered options and adaptive questioning (see
\`common.md\`). Ask about prerequisites and manual steps (see \`common.md\`): the
issue's existing blocking relations may already answer this.

## Step 3: Size the work

Apply the Sizing rule from \`common.md\`. State the size (Fix, Story, Epic or
Feature) with its t-shirt estimate, the reason, and the resulting structure
before continuing.

## Step 4: Write the work item

- **Fix or Story:** a single task in the task format: its three paragraphs,
  framed as a fix for a bug and as a story otherwise. It replaces the current
  description, including one in an older format (a story sentence with a
  \`Covers:\` line, or \`## Current behavior\` / \`## Expected behavior\`
  sections).
- **Epic:** the epic format, with its numbered requirements. It replaces the
  current description.
- **Feature:** don't rewrite the description. Write a comment recommending
  feature planning: that it is too big for one epic, the reason it is a
  feature, and a first cut of the epics it splits into, in the order they
  would ship (a plain title and a sentence or two on what each delivers, split
  by what each delivers, never by development phase). Skip Step 5.

## Step 5: Tasks (Epic only)

Split the epic into tasks by the Splitting rule, each in the task format (a
fix for a bug, a story otherwise), and present them as \`common.md\` →
"Drafting tasks with the user" shows. Don't add a validation task: Omniralph audits the
epic against its requirements before its pull request opens.

## Final step: update the issue in {{trackerName}}

Once the work item (plus its tasks, if an **Epic**) or the Feature comment is
written, have the user review and confirm. Only after they confirm, use the
{{trackerName}} MCP tools to update the **existing** issue, following
\`common.md\` → "{{trackerName}} structure reference".

**If a Feature, only comment:**

- Post the recommendation and the first cut of the epics as one comment on
  the issue.
- Leave its title, description, labels and relations as they are, and do
  **not** create any sub-issues or other issues: the epics are filed when the
  feature is planned.

**For a Fix, a Story or an Epic:**

- Update the title to a descriptive but concise name (keep the existing title
  if it already fits).
- Replace the description with the new one and the branch line, if any. Keep
  an existing \`[repo=…]\` tag only if the user wants it (see \`common.md\` →
  "Routing and branch lines").
- Keep the existing labels, priority, assignee and blocking relations unless
  the user asks otherwise. Add \`blockedBy\` for any new prerequisites.
- Keep any existing comments.

**If an Epic, turn it into an epic:**

- Create a sub-issue for each task, in task order: plain task title, the
  task's three paragraphs, a priority, its \`blockedBy\` dependencies, the
  manual label for steps for a person, and the bug label for a fix.
- Do the post-creation steps: replace drafting labels with {{trackerName}}
  identifiers, and verify the blocks relations.

**If a Fix or a Story, keep it a single task:**

- The description is the task's three paragraphs. Add the bug label if it is
  a fix and doesn't have it yet.
- Do **not** create any sub-issues.

## Checklist before updating the issue

- [ ] Loaded and summarized the existing issue for the user
- [ ] Asked clarifying questions with lettered options, targeted at actual gaps
- [ ] Incorporated the user's answers
${PLAN_CHECKLIST}

Once the issue is updated (or, for a Feature, commented on), tell the user
you're done.`,
};

/** `edit`: revise an existing epic or task. */
export const MODE_EDIT: PluginMode = {
  id: "edit",
  file: "mode-edit.md",
  body: `# Mode: edit

You are revising an existing epic or single task. It may not follow the
planning formats yet: part of your job is to bring it to them during the edit
(subject to the user's preference below).

Follow the planning rules in \`common.md\`.

---

## Step 1: Load the existing work

Before doing anything else, use the {{trackerName}} MCP tools to fetch the
issue and all of its sub-issues.

- Read the epic's (or the task's) full description.
- Enumerate every sub-issue, including a legacy \`Validate functional
  requirements\` task if one exists.
- Note each sub-issue's identifier, title, description, status, priority,
  labels (especially the manual label), and blocking relations.
- Note any sub-issues already completed, in progress, or cancelled: these
  constrain what can change.
- Check whether the epic is delegated to Omniralph or has an active agent
  session. If it does, Omniralph may be working a task right now.
- Look for an older format: a description with Introduction, Goals or
  Non-Goals sections, lists of metrics or of commands to run, stories as
  \`### US-001: …\` headings, \`US-001:\` title prefixes,
  \`## Ralph Metadata\` sections (Story ID, Ralph Priority, Dependencies), and
  tasks written as a story sentence ("As a … I want …") with a \`Covers:\`
  line and an \`## Acceptance Criteria\` checklist, or as
  \`## Current behavior\` / \`## Expected behavior\` /
  \`## Unchanged behavior\` sections.

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

Use lettered options and adaptive questioning (see \`common.md\`), fewer rounds
if the edit is small and well-specified. Example starter set:

\`\`\`
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
\`\`\`

If the user picks 2C, warn them: reopening a Done task makes Omniralph run it
again on the next delegation, on top of code that is already on the epic
branch. Its acceptance criteria should describe the change still needed, not
the whole task again.

When rewriting an older format, map it onto the epic format: the introduction
becomes \`## Problem\`, goals and non-goals become \`### In\` and \`### Out\`
under \`## Scope\`, design and technical considerations become \`## Design\` and
\`## Technical notes\`, and the functional requirements become
\`## Requirements\`. Drop lists of commands to run and of metrics: the repo
decides the checks, and outcomes belong in planning documents.

When rewriting a task in an older format, map it onto the task format: the
story sentence (or the current and expected behavior of a fix) becomes the
"I want you to" paragraph, its notes on how to build it the "Build it by"
paragraph, and its acceptance criteria (with the unchanged behavior of a fix)
the "Don't stop until" paragraph. Drop its \`Covers:\` line.

## Step 3: Write the revised work item

After incorporating the user's answers, write the revised epic or task in the
planning formats (subject to the format preference from Step 2), adding
missing sections.

Also add a **Change Log** section (cumulative: keep any prior entries) at the
end of an epic, before the branch line:

\`\`\`markdown
## Change Log

- What changed (sections, tasks, requirements)
- What is unchanged
- Any sub-issues closed, reopened, added, or whose dependencies shifted
\`\`\`

Refer to tasks in the Change Log by {{trackerName}} identifier. A single task
has no Change Log section: it stays three paragraphs, so give the user the
change summary in the conversation instead.

## Step 4: Re-size the work

Apply the Sizing rule from \`common.md\`, then compare against the issue's
current structure:

- Already an epic and still an **Epic**: keep the epic.
- Currently a single task but grown to an **Epic**: recommend turning it into
  an epic, but confirm before restructuring.
- Currently an epic but shrunk to a **Fix** or a **Story**: tell the user.
  Collapsing an epic into a single task is a significant change that must be
  confirmed, and you must never collapse sub-issues that are already
  completed or in progress.
- Grown to a **Feature**: don't grow it into a bigger epic. Tell the user it is
  too big for one pull request and recommend planning it as a feature, epic by
  epic, with the reason and a first cut of the epics it splits into. Ask
  whether to keep this edit within one epic's (or task's) scope, moving the
  rest out to feature planning, or to stop and plan the feature first. Never
  file the other epics from this mode.

## Step 5: Reconcile tasks (if the issue is or stays an epic)

Reconcile the existing tasks with the requested edits. For each task, decide:
**Keep as-is**, **Edit**, **Add**, **Remove** (only if not yet started;
otherwise flag), or **Reorder**. Present the reconciliation explicitly:

\`\`\`
ENG-12: Keep as-is
ENG-13: Edit (new acceptance criterion for empty state)
ENG-14: Remove (superseded by new-2)
ENG-15: Keep as-is
new-1:  Add (blocked by ENG-13)
new-2:  Add (blocked by ENG-15)
\`\`\`

Guidelines:

- Existing tasks are named by their {{trackerName}} identifier, which never
  changes: Omniralph's commits and progress log reference it. Label new tasks
  \`new-1\`, \`new-2\`, … until they are created.
- Each edited or new task follows the task format, with a priority, blocks
  relations, and the manual label or the bug label where it applies.
- **Older markup** (if the user chose to rewrite): remove \`## Ralph Metadata\`
  sections and \`US-001:\` title prefixes from pending tasks only. Omniralph
  uses a legacy \`Ralph Priority\` when a sub-issue has no {{trackerName}}
  priority, so set the {{trackerName}} priority first. Leave completed and
  in-progress tasks untouched.
- Don't add a validation task. A legacy one is kept as a task; if it is
  labelled manual, explain that Omniralph opens the pull request only once
  every task is done (unless the repo sets \`openPullRequestEarly\`), and ask
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

## Final step: apply changes in {{trackerName}}

Present a diff-style summary to the user: sections that changed; tasks kept,
edited, added, removed or reordered; requirements added, edited or removed. If
your re-sizing changes the structure (a single task becoming an epic, or an
epic collapsing into a single task), also summarize the proposed restructuring
and get explicit confirmation before applying it. A Feature is never applied:
apply only the in-scope edit the user chose in Step 4.

Have the user review and confirm before touching {{trackerName}}. Only after
they confirm, use the {{trackerName}} MCP tools:

- Update the issue's description with the revised epic or task.

**If the issue stays (or becomes) an Epic:**

- Per task: **Keep**, no action; **Edit**, update the sub-issue's title and
  description; **Add**, create a new sub-issue (see \`common.md\` →
  "{{trackerName}} structure reference") with its priority, \`blockedBy\`
  dependencies and labels; **Remove**, cancel the sub-issue (do not delete)
  and note it in the Change Log; **Reorder**, update blocks relations
  (\`blockedBy\` / \`removeBlockedBy\`) and priorities to reflect the new
  order. Blocks relations carry the order; the sub-issue order in the parent
  is cosmetic, so don't mention it to the user.
- Replace any \`new-N\` labels in descriptions with the new {{trackerName}}
  identifiers.
- If the epic has a legacy validation task, update it to list the revised
  requirements, and make sure it is blocked by every new task too.
- If a single task is being turned into an epic, create the tasks as in the
  \`new\` and \`triage\` final steps, with no validation task.

**If the issue stays (or becomes) a single task, a Fix or a Story:**

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
- [ ] Kept requirement numbers; referred to tasks by {{trackerName}} identifier
${PLAN_CHECKLIST}
- [ ] Warned the user if Omniralph is running on the epic or a Done task is
      being reopened
- [ ] Change Log entry written
- [ ] Did not silently modify completed or in-progress sub-issues, or
      restructure the issue without confirmation

Once the changes are applied, if Omniralph is running on the epic, tell the
user it picks them up from a reply in its session. Then tell the user you're
done. Don't offer to delegate or re-delegate the epic.`,
};

/**
 * The body of a ui-loop epic's review task, in the task format, with \`<…>\`
 * placeholders the skill fills in. Its round steps, anchoring rules and
 * reporting rules are the builder's guidance ("Build it by"); what the
 * verifier checks is in "Don't stop until".
 */
export const REVIEW_TASK_TEMPLATE = `I want you to review this round of UI/UX work against the last one, for the project owner, so that the loop files the next round of fixes and ends once the bar is cleared. This task reviews; it doesn't fix: everything it finds is reported as follow-ups.

Build it by running each round in these steps:

1. **Checks.** Run the repo's checks, the screenshot command and \`impeccable detect\` on <target> (and on each consumer listed in the epic). Record the output.
2. **Requirements.** Verify FR-1 … FR-n and every completed task's done criteria, with evidence (command output or screenshot path).
3. **Critique.** Run \`/impeccable critique <target>\` at <viewports> in <themes>, anchored to the previous review as below. <Lean mode only: if \`.impeccable/critique/\` holds no \`*__<slug>.md\` yet, this is the baseline round: run a normal, unanchored critique.>
4. **Keep the report.** Leave it in the worktree under \`.impeccable/critique/\`. Omniralph commits it with the round (as \`wip(…)\` when the round reports blocked, which needs the repo's checks to pass), and the next round anchors to it.
5. **Post one comment** on this issue: \`Round N: PASS|FAIL\`, the score and its trend across rounds, P0/P1/P2 counts, the checks table, the requirements table, and the follow-ups filed.

**Anchoring the critique.** This overrides the critique skill's default, which shows Assessment A no earlier runs.

1. **Find the previous review.** It is the newest \`.impeccable/critique/*__<slug>.md\`. Find the commit that added it with \`git log -1 --format=%H -- <file>\`. The code changed since then is \`git diff --stat <commit> -- <target> <other paths>\`.
2. **Give Assessment A the previous review and that diff.** Assessment B stays isolated. A must:
   * **Re-check every previous Priority Issue and heuristic key issue.** Mark each *fixed*, *still open* or *regressed*, with a file:line or screenshot as evidence.
   * **Start each heuristic at its previous score.** Change a score only for a stated reason: a previous issue fixed (up), or a regression or new problem in code changed since the previous review (down).
   * **Report problems in unchanged code as *newly noticed*.** A newly noticed P0 or P1 can lower its heuristic. A newly noticed P2 or P3 is listed but doesn't change the score.
3. **Show the comparison.** The report header names the previous review. A *Changes since the previous review* table lists each earlier issue's status and each score change with its reason.

Detector findings checked and judged false positives go in \`.impeccable/critique/ignore.md\` with the reason, so later rounds don't re-litigate them.

**What to report.**

* **The bar is cleared** (score ≥ <N>/40, zero <blocking severities>, every check and requirement holds): report **complete** with no follow-ups. List any remaining lower-severity notes in the comment only; the loop is done.
* **Otherwise** report **blocked**, with follow-ups for every <filed severities> finding and every failing requirement or check.
* **Every round**, report the score as \`metric\`: name \`critique score\`, the value, direction \`higher\` and target <N>. Keep the name and direction the same every round: the loop is set aside when the best score stops improving.
  * Group findings into at most 8 follow-ups, each one session of work, layer by layer. Each states its finding, the evidence and checkable done criteria.
  * Reuse an open sub-issue that already covers a finding rather than filing a duplicate.
  * Anything under the epic's \`### Out\` is a P3 note, never a follow-up.
  * A follow-up for a person (e.g. a commit in another repo) is marked manual. File it only if this task can't pass without it.

Don't stop until:
- The round's critique, anchored to the previous review (or the baseline in round one), is saved under \`.impeccable/critique/\`
- The critique scores ≥ <N>/40 with zero <blocking severities> findings
- FR-1: …
- Every done criterion of the epic's completed tasks still holds
- \`impeccable detect\` exits 0 on <target> (and listed consumers)
- The repo's checks pass
- No file outside \`.impeccable/critique/\` changes: this task reviews, it doesn't fix`;

/** `ui-loop`: an epic that improves a UI in critique rounds until it clears a bar. */
export const MODE_UI_LOOP: PluginMode = {
  id: "ui-loop",
  file: "mode-ui-loop.md",
  body: `# Mode: ui-loop

You are creating an epic that improves the UI/UX of a project **in a loop**:
Omniralph builds a round of fixes, then a review task critiques the result with
the impeccable design skill and files the next round as new sub-issues. That
continues until the critique clears a quality bar. Write it to {{trackerName}}.

Invocation: \`/omniralph-prd ui-loop [--lean] [--target <path>] [context]\`.

- **Seeded (the default).** You run the baseline critique now, ask the user
  the design decisions it raises, and create the first round of tasks from it.
  The review task then starts at round 2.
- **Lean (\`--lean\`).** You skip the critique. The epic holds only the setup
  tasks and the review task. Its first pass writes the baseline critique and
  files round 1 as follow-ups. Use it when the user doesn't want to sit
  through a critique now, or wants to make no design calls up front.
- \`--target\` is the surface to critique (e.g. \`src\`, \`app\`,
  \`src/components\`). If it is missing, infer it from the repo and confirm it.

Follow the planning rules in \`common.md\`. This mode always produces an
**epic**, whatever its size.

---

## How the loop works (explain this to the user once)

The review task is an ordinary Omniralph story, last in the epic and blocked
by every other sub-issue. When its round finds problems that block the bar, it
reports **blocked** with the problems as \`followUps\`. Omniralph files them as
sub-issues of the epic that block the review task. It builds them, then re-runs
the review task. When a round clears the bar, the task reports **complete**,
and any remaining non-blocking findings join the epic as ordinary tasks. When
those are done, Omniralph opens the pull request.

**Round limit.** A round that reports blocked and files follow-ups doesn't use
one of the task's attempts. Omniralph caps rounds separately and sets the task
aside in either of these cases:

- **Round cap.** It reaches 8 rounds (the coding task's \`maxRoundsPerStory\`).
- **Stall.** The review task reports its critique score as a \`metric\` each
  round. When the best score hasn't improved for 3 rounds in a row
  (\`stallRounds\`), Omniralph stops and shows the score trend.

A reply of \`/continue\` (or any guidance reply) in the agent session gives the
task fresh rounds and clears its score history. Tell the user this when you
finish.

---

## Step 1: Prerequisites

Check these before anything else, and stop to fix any that fail:

1. **impeccable is installed** in this session (the \`impeccable:impeccable\`
   skill). If not, tell the user to install the plugin and retry.
2. **impeccable is available to Omniralph's sessions.** Task sessions run on an
   Omniralph agent and load the agent user's \`~/.claude\` plugins and
   skills and the repo's \`.claude/\`. Ask the user to confirm the plugin is
   installed for that user on every agent that accepts \`coding\` tasks (or
   the one the repo is pinned to). If it isn't, the review task can't run, so
   this must be fixed first.
3. **Design context exists.** If the target repo has no \`PRODUCT.md\`, run
   \`/impeccable init\`. If it has no \`DESIGN.md\`, run
   \`/impeccable document\`. If the user would rather not do this now, make it
   the first task of the epic.
   - **A consumer of a design-system library** that already has its own
     \`DESIGN.md\`: don't re-document the library's tokens. Write a short
     \`DESIGN.md\` that names the library's file as the authority and records
     only how this app applies it and where it departs from it. If the epic
     will upgrade the library, describe the target version, not the incumbent
     one.
   - **Both files must be on the default branch before the epic is
     delegated**, because runs branch from it. Commit them on a branch and
     open a pull request, or commit to the default branch if the user prefers.
     Remind the user to merge it before the epic is delegated.
4. **A screenshot loop exists.** The review task and every UI task need to
   render the UI and screenshot it unattended: a showcase, Storybook, or the
   app's dev server, plus a committed script that captures named screens at
   given viewports and themes. Look for one. If there is none, the epic's
   first task builds it.
   - Ask how the agent host runs a browser: a Playwright MCP, a local
     Playwright/Chromium, or a container such as
     \`mcr.microsoft.com/playwright:<version>\`. Ask this with your Step 1
     questions, not at the end.
   - **An app behind sign-in or backed by a database** needs two setup tasks,
     not one:
     1. A fixture seed with stable IDs that covers every state the screens
        show, plus a dev-only sign-in. Gate it on an env var **and** a
        non-production check, so it is provably off in production.
     2. The screenshot command that uses it, with a committed route list, a
        scroll-width check at the narrowest viewport, and a \`--strict\` flag
        for the review task.
   - Record the answer, and any quirks (remote Docker daemon → \`docker cp\`
     instead of bind mounts), in the epic's \`## Technical notes\`.
   - If the target's \`{{conventionsFile}}\` forbids browser sessions in
     acceptance criteria, the script must be a plain repo command (e.g.
     \`pnpm verify:screens\`) that runs headless and writes files. That still
     counts as evidence inside the repo.

## Step 2: Clarifying questions

Ask these with lettered options (see \`common.md\`). Skip any the context
answers:

1. **The bar.** Ask for the critique score that ends the loop. Default: 32/40
   with zero P0 and zero P1. In seeded mode, propose baseline + 8 to 10,
   capped at 34.
2. **Viewports and themes** to verify. Default: 1440px and 390px, and every
   theme the project ships.
3. **Blocking severity.** Ask what a failing round files. Default: a round
   fails on any P0 or P1 (or the score below the bar). A failing round files
   follow-ups for P0, P1 and P2; P3 is listed in its report and not filed. A
   passing round reports complete and files nothing more.
   - Some users want everything fixed while the loop is still running: a
     failing round also files P2s, or P3s. If so, bundle the P3s into one
     polish follow-up per round, so they cost one task rather than several.
   - Omniralph makes **every** follow-up of a failing round block the review
     task. So whatever a failing round files is built before the next round,
     and a completing round should file nothing that isn't meant to join the
     epic as more work.
4. **Guardrails.** Ask whether the epic should first add automated checks that
   stop regressions between rounds. Examples: lint rules banning raw colours,
   arbitrary sizes and durations outside the token layer, and a WCAG contrast
   check over token pairs. Recommend them for a design system or component
   library. For a small app, they are optional.
5. **Scope fence.** Ask what the loop must not turn into. Default: no new
   features, pages or component families; no palette or font changes; no
   dependency upgrades. Findings that need these are P3 notes, not follow-ups.
   Without a fence, each round's fresh eyes find new feature work, and the
   loop doesn't converge.

## Step 3 (seeded only): Baseline critique and decisions

If Step 1 found no screenshot loop, a seeded baseline can't see the running
app. Offer three options:

- **Lean.** Switch to lean mode, so round 1 makes the full visual baseline
  once the setup tasks land.
- **Code-only seed.** Critique the code and run \`impeccable detect\` now, and
  seed the tasks from that. Round 1 still writes the first visual baseline.
- **Run it now.** The user runs the app locally for a full critique.

1. Run \`/impeccable critique <target>\`. Use its normal dual assessment, with
   screenshots at the agreed viewports and themes.
2. Make sure the report is saved at
   \`.impeccable/critique/<timestamp>__<slug>.md\`, then ask the user to commit
   it, or commit it yourself with their OK. The loop finds the previous review
   through git history, so the baseline **must be committed** before the epic
   runs.
3. Note the score, and the P0/P1 counts.
4. The critique raises design calls that only the user can make: direction,
   default theme, what the signature element means, which convention wins when
   two compete. Ask them as lettered questions, one round, and record each
   answer in the epic's \`## Design\`. The tasks and every later round are bound
   by them.

## Step 4: Write the epic

Write the epic in the epic format, with:

- **Problem.** The product in a sentence and what is wrong with its UI today.
  In seeded mode, give the baseline score, the critique path and the 4 to 6
  headline findings. In lean mode, say the first review round writes the
  baseline.
- **Scope.** Under \`### In\`: clearing the bar (score, P0, P1), plus what the
  decisions commit to, e.g. "every text pair meets WCAG AA in both themes".
  Under \`### Out\`: the scope fence from Step 2.
- **Design.** Name \`DESIGN.md\` and \`PRODUCT.md\` as the design authority.
  List the decisions from Step 3, and say these rules bind every round.
- **Technical notes.** Where the tokens and styles live, how the screenshot
  loop runs and its quirks, how consumers pick up the change, and that every UI
  task runs \`<screenshot command>\` and inspects screenshots of the changed
  screens at <viewports> in <themes> before reporting complete.
- **Requirements.** The epic's lasting invariants: what must stay true after
  any round. Examples: the contrast check passes in every theme; no raw colours
  in components; no horizontal scroll at the narrowest viewport;
  \`impeccable detect\` exits 0. Don't use one-off fixes as requirements.
- **Size.** XL is typical. The epic shape is fixed regardless of size.
- Routing and branch lines as in \`common.md\`.

## Step 5: Tasks

In task order, each in the task format:

1. **Setup** (only what Step 1 found missing): commit the design context,
   build the screenshot loop.
2. **Guardrails** (if chosen): the lint guard rules, the contrast check. Both
   go first, so every later task is held to them.
3. **Seeded only, round-1 tasks.** Group the baseline's P0, P1 and in-scope P2
   findings into tasks of one session each, by layer: tokens first, then
   components, then pages and screens. Then group consumers and docs. Each
   criterion points to a finding and is evidence an agent can check: a lint
   rule, the contrast script, a command's output, or a named screenshot
   inspected.
4. **The review task**, last, blocked by every other sub-issue. It checks
   every requirement. Title:
   \`Validate the UI/UX bar and functional requirements\`. Body: the template
   below.

### Review task template

Fill in the \`<…>\` placeholders. Keep the rest verbatim: the anchoring rules
are what make the score track progress rather than reviewer variance.

\`\`\`markdown
${REVIEW_TASK_TEMPLATE}
\`\`\`

## Final step: save to {{trackerName}}

Show the user a summary table before writing: the size, the tasks with
priority and blockers, the bar, and the mode. Then follow \`mode-new.md\` →
"Final step" for an epic, with the review task as the last sub-issue. That
covers the epic issue, the sub-issues in task order, the review
task blocked by all of them, and the post-creation steps.

When you finish, tell the user two things (and don't offer to delegate; see
\`common.md\` → "Delegating to Omniralph"):

- It runs at most 8 rounds, and stops sooner if the score doesn't improve for
  3 rounds in a row. A \`/continue\` reply gives it fresh rounds (see "Round
  limit").
- To review the loop's progress, check the review task's comments.

## Checklist before creating the issues

- [ ] impeccable confirmed installed here and on the Omniralph agent hosts
- [ ] \`PRODUCT.md\`/\`DESIGN.md\` committed, or a setup task creates them
- [ ] A screenshot command exists, or a setup task builds it; host browser method recorded
- [ ] Seeded: baseline critique committed, decisions recorded in \`## Design\`
- [ ] The bar is in \`### In\` and the scope fence in \`### Out\`
- [ ] The review task is last, blocked by every other sub-issue, and its placeholders are filled in
- [ ] Requirements are lasting invariants, not one-off fixes
- [ ] Everything in \`mode-new.md\`'s checklist for an epic`,
};

/** What each planning document is called, and the control panel's editor for it. */
const DOCUMENT_NAMES: Record<FeatureDocumentKind, string> = { prfaq: "PRFAQ", plan: "Plan" };

/**
 * How a `prfaq` or `plan` mode finds the feature and its current document: through the
 * Omniralph API when the session has it configured, from the person otherwise.
 */
function documentSource(kind: FeatureDocumentKind): string {
  const name = DOCUMENT_NAMES[kind];
  return `## Step 1: Find the feature

Work out where the ${name} goes before drafting it.

**The Omniralph API is configured** when the session has both the
\`OMNIRALPH_URL\` (the control panel's address, e.g.
\`https://omniralph.example.com\`) and \`OMNIRALPH_API_TOKEN\` environment
variables and a shell to call it from (Claude Code). Check with
\`test -n "$OMNIRALPH_URL" && test -n "$OMNIRALPH_API_TOKEN" && echo configured\`,
never by printing the token. Send every request with
\`-H "Authorization: Bearer $OMNIRALPH_API_TOKEN"\`, and JSON bodies with
\`-H "Content-Type: application/json"\`. When it is configured:

1. List the features: \`GET $OMNIRALPH_URL/api/ui/features\` answers
   \`{ "features": [{ "id", "name", "status", "repository" }] }\`, newest first.
2. Ask which feature the ${name} is for, with the features in \`planning\` as
   lettered options and a last option to create a new one. To create one, ask
   for its name (and its repo, if the context names one) and send
   \`POST $OMNIRALPH_URL/api/ui/features\` with \`{ "name": "…" }\`; it answers
   \`{ "ok": true, "feature": { "id", … } }\`. An \`archived\` feature takes no
   new versions: offer to create a new feature instead.
3. Load the current ${name}:
   \`GET $OMNIRALPH_URL/api/ui/features/<id>/documents/${kind}\` answers
   \`{ "version", "body" }\`, version \`0\` and an empty body when it was never
   saved. Remember the version: the save sends it back. A non-empty body is the
   person's draft: revise it rather than starting over, and keep their
   structure and wording where it still holds.

If the API answers 401 or 403, the token is missing, expired or not allowed:
say so, and carry on without the API. Any other failure: show the status and
the \`error\` of the JSON answer, and ask whether to retry or carry on without
the API.

**The Omniralph API is not configured** (or the person chose to carry on
without it): say that you'll produce the ${name} for them to paste into the
feature's ${name} in the Omniralph control panel (**Features**, then the
feature). Ask whether they already have a draft, and if so, ask them to paste
it so you revise it rather than starting over.`;
}

/** How a `prfaq` or `plan` mode saves the document it drafted. */
function documentSave(kind: FeatureDocumentKind): string {
  const name = DOCUMENT_NAMES[kind];
  return `## Final step: save the ${name}

Have the person review the whole ${name} and confirm it is ready to save.
Only after they confirm:

**With the Omniralph API**, save it as the feature's new version:
\`PUT $OMNIRALPH_URL/api/ui/features/<id>/documents/${kind}\` with
\`{ "body": "<the ${name} as Markdown>", "baseVersion": <the version you loaded> }\`.
Write the ${name} to a file and build the JSON with a tool that escapes it,
e.g. \`jq -n --rawfile body ${kind}.md --argjson baseVersion <version> '{body: $body, baseVersion: $baseVersion}'\`,
never by pasting the text into a quoted string. Earlier versions are kept, so
a save never loses the person's work.

- \`{ "ok": true, "document": { "version" } }\`: tell the person the version
  saved.
- 409 with \`"code": "stale_version"\`: someone saved a later version while you
  were drafting. Load it again, show the person what changed, fold their
  choice into the draft and save against the new version. Never overwrite it
  without asking.
- 409 with \`"code": "archived"\`: the feature was archived. Say so and offer
  to create a new feature for it.
- Any other failure: show the status and \`error\`, then give the person the
  ${name} to paste instead.

**Without the Omniralph API**, give the person the whole ${name} as one
Markdown block, ready to paste into the feature's ${name} in the control
panel, and tell them where it goes.

Write nothing to {{trackerName}}: a ${name} is a feature's document, not an
issue.`;
}

/** `prfaq`: draft a feature's PRFAQ with the person. */
export const MODE_PRFAQ: PluginMode = {
  id: "prfaq",
  file: "mode-prfaq.md",
  body: `# Mode: prfaq

You are drafting a feature's PRFAQ with the person: the feature told from the
side of the people who will use it, as if it had already shipped. It is where
a feature starts, before its Plan. The PRFAQ rule below is its format; it is
flexible, so follow the person's own structure when they have one.

If the invocation included a \`context\`, treat it as the feature's background.
If it didn't, ask what the feature is before going further.

---

${documentSource("prfaq")}

## Step 2: Clarifying questions

Ask 3–5 essential questions where the context leaves the feature unclear,
with lettered options and adaptive questioning (see \`common.md\`):

- **Who:** Who will use it, and what do they do today instead?
- **Problem:** What is painful about that, and why does it matter now?
- **Promise:** What changes for them when it ships, in their words?
- **Edges:** What will people ask that the feature doesn't do?
- **Success metrics:** Do they want the optional section, and if so, how will
  they judge the feature once it ships?

Don't re-ask what the context or an existing draft already answers: confirm
your understanding instead.

## Step 3: Draft the PRFAQ

Write it by the PRFAQ rule: the press release, then the FAQ, then the success
metrics only if the person wants them. Keep it short and concrete, in the
users' language. Settle every FAQ answer with the person; never leave a
placeholder or a question unanswered.

## Step 4: Review and revise

Show the whole draft, ask what to change, and revise until the person is happy
with it. Point out where the press release promises something the FAQ
contradicts, or where an answer is vague.

${documentSave("prfaq")}

When it is saved or handed over, suggest the next step: drafting the feature's
Plan with \`/omniralph-prd plan\`.

## Checklist before saving

- [ ] Found the feature through the Omniralph API, or told the person they'll
      paste the PRFAQ themselves
- [ ] Revised the existing draft rather than replacing it, if there was one
- [ ] Asked clarifying questions with lettered options
- [ ] A press release and an FAQ, in the person's structure if they have one
- [ ] Every FAQ answer settled with the person; no placeholders
- [ ] Success metrics only if the person wanted them, and nowhere but their
      own section
- [ ] No implementation detail, epics or tasks
- [ ] The person confirmed before saving`,
  rules: [PRFAQ_RULE, SUCCESS_METRICS_RULE],
};

/** `plan`: draft a feature's Plan with the person, naming the epics it expects. */
export const MODE_PLAN: PluginMode = {
  id: "plan",
  file: "mode-plan.md",
  body: `# Mode: plan

You are drafting a feature's Plan with the person: how the feature is built,
ending with the epics it expects. Omniralph shards the Plan into epics later,
and a person reviews them before anything is filed, so you write no epics,
requirements or tasks here. The Plan rule below is its format; it is flexible,
so follow the person's own structure when they have one.

If the invocation included a \`context\`, treat it as the feature's background.
If it didn't, ask what the feature is before going further.

Follow the planning rules in \`common.md\` for sizing and splitting: each
epic the Plan names is sized as an Epic and split by what it delivers.

---

${documentSource("plan")}

Then read the feature's PRFAQ, if it has one: with the API,
\`GET $OMNIRALPH_URL/api/ui/features/<id>/documents/prfaq\`; without it, ask
the person to paste it. The Plan builds what the PRFAQ promises: note any
promise it would leave out, and ask the person about it.

## Step 2: Read the repo

If you have source access (see "Accessing the target repo" in \`SKILL.md\`),
read the parts of the repo the feature touches, targeted, not wholesale, so
the Plan names real components, file paths and patterns to reuse.

## Step 3: Clarifying questions

Ask 3–5 essential questions where the feature is unclear, with lettered
options and adaptive questioning (see \`common.md\`):

- **Scope:** What is in, and what is deliberately left out?
- **Approach:** Which parts, design and technical decisions does it need?
- **Order:** What has to ship first for the rest to build on?
- **Prerequisites:** What must a person do (access, accounts, decisions)?
- **Success metrics:** Do they want the optional section, and if so, how will
  they judge the feature once it ships?

Don't re-ask what the context, the PRFAQ or an existing draft already answers.

## Step 4: Draft the Plan

Write it by the Plan rule: a \`##\` section for each part, the scope and what
it leaves out, success metrics only if the person wants them, and the
\`## ${PLAN_EPICS_SECTION}\` section last. Then check the epics against the
sections: every section saying what the feature delivers is covered by an
epic, no epic builds something the Plan doesn't say, each epic waits only for
earlier epics, and the waits form no cycle. Fix the Plan, or ask the person, until
they hold.

## Step 5: Review and revise

Show the whole draft, with each epic's coverage, ask what to change, and
revise until the person is happy with it. If an epic looks too big for one
pull request, propose splitting it; if a section belongs to no epic, propose
where it goes.

${documentSave("plan")}

When it is saved or handed over, tell the person the next step happens in
Omniralph: **Shard into epics** on the feature's page drafts the epics from
the Plan for them to review before anything is filed.

## Checklist before saving

- [ ] Found the feature through the Omniralph API, or told the person they'll
      paste the Plan themselves
- [ ] Read the PRFAQ, if there is one, and asked about any promise the Plan
      leaves out
- [ ] Revised the existing draft rather than replacing it, if there was one
- [ ] Asked clarifying questions with lettered options
- [ ] A \`##\` heading for each part; the full scope stated, nothing labelled
      later or optional unless the person did
- [ ] Success metrics only if the person wanted them, and nowhere but their
      own section
- [ ] \`## ${PLAN_EPICS_SECTION}\` names each expected epic in shipping order,
      with what it delivers, its \`Covers:\` and, when it waits for earlier
      epics, its \`After:\`
- [ ] Every section saying what the feature delivers is covered by an epic,
      and no epic adds scope the Plan lacks
- [ ] Epics split by what each delivers, never by phase, each sized as an Epic
- [ ] Epics wait only for other epics, with no cycle
- [ ] No requirements or tasks written in the Plan
- [ ] The person confirmed before saving`,
  rules: [PLAN_RULE, SUCCESS_METRICS_RULE],
};

/** Every mode, in the order the skill lists them. */
export const PLUGIN_MODES: readonly PluginMode[] = [
  MODE_NEW,
  MODE_TRIAGE,
  MODE_EDIT,
  MODE_UI_LOOP,
  MODE_PRFAQ,
  MODE_PLAN,
];
