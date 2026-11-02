<!-- Generated from the omniralph repo (packages/planning/src/plugin, built by scripts/build-prd-plugin.ts). Do not edit by hand: change it in the omniralph repo, and CI publishes it here. -->

# Mode: triage

You are triaging an existing Linear issue into the planning formats.
The issue is not yet planned: it may be a one-line description, a bug report,
a loose collection of thoughts, a feature request with partial detail, or an
older format. Your job is to elicit the missing context and write the full
structure back to the **same** issue.

Depending on the size, the issue becomes an epic (with one sub-issue per task,
when the work is **L** or larger) or stays a single story or fix (when
smaller).

Follow the planning rules in `common.md`.

---

## Step 1: Load and summarize the issue

Before asking anything, use the Linear MCP tools to fetch the target
issue.

- Read the title, description, comments, labels, and any linked issues.
- Note the issue's current state, priority, and assignee.
- Decide whether it is a bug (a fix) or new work (a story), and identify what
  is already specified and what is missing relative to the formats.
- If the description has a `## Open Questions` section (Omniralph's automated
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
`common.md`). Ask about prerequisites and manual steps (see `common.md`): the
issue's existing blocking relations may already answer this.

## Step 3: Size the work

Apply the Sizing rule from `common.md`. State the size, the rationale, and the
resulting structure before continuing.

## Step 4: Write the work item

- **L or larger:** the epic format, with its numbered requirements. It
  replaces the current description.
- **Smaller than L:** a single task in the task format: its three paragraphs,
  framed as a fix for a bug and as a story otherwise. It replaces the current
  description, including one in an older format (a story sentence with a
  `Covers:` line, or `## Current behavior` / `## Expected behavior`
  sections).

## Step 5: Tasks (L or larger only)

Split the epic into tasks by the Splitting rule, each in the task format (a
fix for a bug, a story otherwise), and present them as `common.md` →
"Drafting tasks with the user" shows. Don't add a validation task: Omniralph audits the
epic against its requirements before its pull request opens.

## Final step: update the issue in Linear

Once the work item (plus its tasks, if **L or larger**) is written, have the
user review and confirm. Only after they confirm, use the Linear MCP
tools to update the **existing** issue, following `common.md` →
"Linear structure reference".

In both cases:

- Update the title to a descriptive but concise name (keep the existing title
  if it already fits).
- Replace the description with the new one and the branch line, if any. Keep
  an existing `[repo=…]` tag only if the user wants it (see `common.md` →
  "Routing and branch lines").
- Keep the existing labels, priority, assignee and blocking relations unless
  the user asks otherwise. Add `blockedBy` for any new prerequisites.
- Keep any existing comments.

**If L or larger, turn it into an epic:**

- Create a sub-issue for each task, in task order: plain task title, the
  task's three paragraphs, a priority, its `blockedBy` dependencies, the
  manual label for steps for a person, and the bug label for a fix.
- Do the post-creation steps: replace drafting labels with Linear
  identifiers, and verify the blocks relations.

**If smaller than L, keep it a single task:**

- The description is the task's three paragraphs. Add the bug label if it is
  a fix and doesn't have it yet.
- Do **not** create any sub-issues.

## Checklist before updating the issue

- [ ] Loaded and summarized the existing issue for the user
- [ ] Asked clarifying questions with lettered options, targeted at actual gaps
- [ ] Incorporated the user's answers
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

Once the issue is updated, tell the user you're done.
