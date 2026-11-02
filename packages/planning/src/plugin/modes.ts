/**
 * The skill's modes (`new`, `triage`, `edit`, `ui-loop`): the plugin-only,
 * interactive step sequences. Each refers to the planning rules in
 * `common.md` by name instead of restating them.
 */

/** A mode of the skill and its reference file. */
export interface PluginMode {
  /** The mode token, e.g. `new`. */
  id: string;
  /** The reference file's name, e.g. `mode-new.md`. */
  file: string;
  /** The file's Markdown, with `{{trackerName}}`/`{{conventionsFile}}` placeholders. */
  body: string;
}

/** The checks shared by every mode's checklist, before it writes to the tracker. */
const PLAN_CHECKLIST = `- [ ] Sized the whole body of work and chose the structure accordingly
      (an epic only if L or larger)
- [ ] The epic has \`## Problem\`, \`## Scope\` (\`### In\` / \`### Out\`) and
      \`## Requirements\`, and nothing else besides the optional design and
      technical notes; a single task is a story, or a fix for a bug
- [ ] Requirements are numbered \`FR-n\` bullets, one behavior each, with WHEN
      or IF only for conditional behavior
- [ ] Every requirement is owned by at least one task's \`Covers:\` line, and
      every \`Covers:\` entry is one of the epic's requirements
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

Depending on the size, it becomes either an epic (a {{trackerName}} issue with
one sub-issue per task, when the work is **L** or larger) or a single story or
fix (when smaller).

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

Apply the Sizing rule from \`common.md\`. State the size, a one-to-two-sentence
rationale, and the resulting structure (an epic with sub-issues, or a single
story or fix) before continuing.

## Step 3: Write the work item

- **L or larger:** write the epic in the epic format, with its numbered
  requirements.
- **Smaller than L:** write a single task: the fix format for a bug, the story
  format otherwise, with no \`Covers:\` line.

## Step 4: Tasks (L or larger only)

Split the epic into tasks by the Splitting rule, each in the story format (or
the fix format for a bug), with a \`Covers:\` line naming the requirements it
owns. Present them as \`common.md\` → "Drafting tasks with the user" shows.
Don't add a validation task: Omniralph audits the epic against its
requirements before its pull request opens.

## Final step: save to {{trackerName}}

Once the work item (plus its tasks, if **L or larger**) is written, have the
user review and confirm it is ready to save. Only after they confirm, use the
{{trackerName}} MCP tools to create the issues, following \`common.md\` →
"{{trackerName}} structure reference":

**If L or larger, create an epic with sub-issues:**

- Create a new parent issue.
  - Give it a descriptive but concise title.
  - Use the epic (with the branch line, if any) as the description.
  - Set \`blockedBy\` for any work item the whole epic waits on.
- Create a sub-issue for each task, in task order.
  - Use the plain task title as the sub-issue title (no drafting label).
  - Use the task in the story or fix format as the description.
  - Set its priority, its \`blockedBy\` dependencies, and the manual label for
    steps for a person.
- Do the post-creation steps: replace drafting labels with {{trackerName}}
  identifiers, and verify the blocks relations.

**If smaller than L, create a single task (no sub-issues):**

- Create one new issue with a descriptive but concise title, the story or fix
  (with the branch line, if any) as its description, and \`blockedBy\` for any
  work item it waits on.
- Do **not** create any sub-issues.

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

Depending on the size, the issue becomes an epic (with one sub-issue per task,
when the work is **L** or larger) or stays a single story or fix (when
smaller).

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

Apply the Sizing rule from \`common.md\`. State the size, the rationale, and the
resulting structure before continuing.

## Step 4: Write the work item

- **L or larger:** the epic format, with its numbered requirements. It
  replaces the current description.
- **Smaller than L:** a single task in the fix format for a bug, the story
  format otherwise, with no \`Covers:\` line.

## Step 5: Tasks (L or larger only)

Split the epic into tasks by the Splitting rule, in the story or fix format,
each with its \`Covers:\` line, and present them as \`common.md\` → "Drafting
tasks with the user" shows. Don't add a validation task: Omniralph audits the
epic against its requirements before its pull request opens.

## Final step: update the issue in {{trackerName}}

Once the work item (plus its tasks, if **L or larger**) is written, have the
user review and confirm. Only after they confirm, use the {{trackerName}} MCP
tools to update the **existing** issue, following \`common.md\` →
"{{trackerName}} structure reference".

In both cases:

- Update the title to a descriptive but concise name (keep the existing title
  if it already fits).
- Replace the description with the new one and the branch line, if any. Keep
  an existing \`[repo=…]\` tag only if the user wants it (see \`common.md\` →
  "Routing and branch lines").
- Keep the existing labels, priority, assignee and blocking relations unless
  the user asks otherwise. Add \`blockedBy\` for any new prerequisites.
- Keep any existing comments.

**If L or larger, turn it into an epic:**

- Create a sub-issue for each task, in task order: plain task title, the task
  in the story or fix format, a priority, its \`blockedBy\` dependencies, and
  the manual label for steps for a person.
- Do the post-creation steps: replace drafting labels with {{trackerName}}
  identifiers, and verify the blocks relations.

**If smaller than L, keep it a single task:**

- The description is the story or fix, with \`## Acceptance Criteria\` last.
- Do **not** create any sub-issues.

## Checklist before updating the issue

- [ ] Loaded and summarized the existing issue for the user
- [ ] Asked clarifying questions with lettered options, targeted at actual gaps
- [ ] Incorporated the user's answers
${PLAN_CHECKLIST}

Once the issue is updated, tell the user you're done.`,
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
  \`### US-001: …\` headings, \`US-001:\` title prefixes, and
  \`## Ralph Metadata\` sections (Story ID, Ralph Priority, Dependencies).

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

Refer to tasks in the Change Log by {{trackerName}} identifier. In a single
task, place the Change Log before \`## Acceptance Criteria\`, which must stay
last.

## Step 4: Re-size the work

Apply the Sizing rule from \`common.md\`, then compare against the issue's
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
- Each kept, edited or new task follows the story or fix format, with its
  \`Covers:\` line, a priority, blocks relations, and the manual label where it
  applies.
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
append new ones at the end rather than renumbering, so \`Covers:\` lines and
other references stay valid.

- "FR-2: WHEN a user clicks X, the system must..." (edited: was about Y)
- "FR-7: [new requirement]"

If a requirement is being removed, mark it removed rather than deleting the
number, and take it out of every \`Covers:\` line:

- "FR-3: ~~[original text]~~ (removed in this revision)"

## Final step: apply changes in {{trackerName}}

Present a diff-style summary to the user: sections that changed; tasks kept,
edited, added, removed or reordered; requirements added, edited or removed. If
your re-sizing crosses the **L** threshold relative to the current structure,
also summarize the proposed restructuring and get explicit confirmation before
applying it.

Have the user review and confirm before touching {{trackerName}}. Only after
they confirm, use the {{trackerName}} MCP tools:

- Update the issue's description with the revised epic or task.

**If the issue stays (or becomes) an epic, L or larger:**

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

**If the issue stays (or becomes) a single task, smaller than L:**

- Keep its acceptance criteria in the story or fix format, last.
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

In task order, each in the story format with its \`Covers:\` line:

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
4. **The review task**, last, blocked by every other sub-issue. It covers
   every requirement. Title:
   \`Validate the UI/UX bar and functional requirements\`. Body: the template
   below.

### Review task template

Fill in the \`<…>\` placeholders. Keep the rest verbatim: the anchoring rules
are what make the score track progress rather than reviewer variance.

\`\`\`markdown
As the project owner, I want each round of UI/UX work reviewed against the last one, so that the loop files the next round of fixes and ends once the bar is cleared.

Covers: FR-1, …, FR-n

This task reviews; it doesn't fix. Everything it finds is reported as follow-ups.

## Each round

1. **Checks.** Run the repo's checks, the screenshot command and \`impeccable detect\` on <target> (and on each consumer listed in the epic). Record the output.
2. **Requirements.** Verify FR-1 … FR-n and every completed task's acceptance criteria, with evidence (command output or screenshot path).
3. **Critique.** Run \`/impeccable critique <target>\` at <viewports> in <themes>, anchored to the previous review as below. <Lean mode only: if \`.impeccable/critique/\` holds no \`*__<slug>.md\` yet, this is the baseline round: run a normal, unanchored critique.>
4. **Keep the report.** Leave it in the worktree under \`.impeccable/critique/\`. Omniralph commits it with the round (as \`wip(…)\` when the round reports blocked, which needs the repo's checks to pass), and the next round anchors to it.
5. **Post one comment** on this issue: \`Round N: PASS|FAIL\`, the score and its trend across rounds, P0/P1/P2 counts, the checks table, the requirements table, and the follow-ups filed.

## Anchoring the critique

This overrides the critique skill's default, which shows Assessment A no earlier runs.

1. **Find the previous review.** It is the newest \`.impeccable/critique/*__<slug>.md\`. Find the commit that added it with \`git log -1 --format=%H -- <file>\`. The code changed since then is \`git diff --stat <commit> -- <target> <other paths>\`.
2. **Give Assessment A the previous review and that diff.** Assessment B stays isolated. A must:
   * **Re-check every previous Priority Issue and heuristic key issue.** Mark each *fixed*, *still open* or *regressed*, with a file:line or screenshot as evidence.
   * **Start each heuristic at its previous score.** Change a score only for a stated reason: a previous issue fixed (up), or a regression or new problem in code changed since the previous review (down).
   * **Report problems in unchanged code as *newly noticed*.** A newly noticed P0 or P1 can lower its heuristic. A newly noticed P2 or P3 is listed but doesn't change the score.
3. **Show the comparison.** The report header names the previous review. A *Changes since the previous review* table lists each earlier issue's status and each score change with its reason.

Detector findings checked and judged false positives go in \`.impeccable/critique/ignore.md\` with the reason, so later rounds don't re-litigate them.

## What to report

* **The bar is cleared** (score ≥ <N>/40, zero <blocking severities>, every check and requirement holds): report **complete** with no follow-ups. List any remaining lower-severity notes in the comment only; the loop is done.
* **Otherwise** report **blocked**, with follow-ups for every <filed severities> finding and every failing requirement or check.
* **Every round**, report the score as \`metric\`: name \`critique score\`, the value, direction \`higher\` and target <N>. Keep the name and direction the same every round: the loop is set aside when the best score stops improving.
  * Group findings into at most 8 follow-ups, each one session of work, layer by layer. Each states its finding, the evidence and checkable acceptance criteria.
  * Reuse an open sub-issue that already covers a finding rather than filing a duplicate.
  * Anything under the epic's \`### Out\` is a P3 note, never a follow-up.
  * A follow-up for a person (e.g. a commit in another repo) is marked manual. File it only if this task can't pass without it.

## Acceptance Criteria

- [ ] The round's critique, anchored as above (or the baseline in round one), is saved under \`.impeccable/critique/\`
- [ ] The critique scores ≥ <N>/40 with zero <blocking severities> findings
- [ ] FR-1: …
- [ ] Every acceptance criterion of the epic's completed tasks still holds
- [ ] \`impeccable detect\` exits 0 on <target> (and listed consumers)
- [ ] The repo's checks pass
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

/** Every mode, in the order the skill lists them. */
export const PLUGIN_MODES: readonly PluginMode[] = [MODE_NEW, MODE_TRIAGE, MODE_EDIT, MODE_UI_LOOP];
