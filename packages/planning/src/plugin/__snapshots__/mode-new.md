<!-- Generated from the omniralph repo (packages/planning/src/plugin, built by scripts/build-prd-plugin.ts). Do not edit by hand: change it in the omniralph repo, and CI publishes it here. -->

# Mode: new

You are planning a piece of software work from scratch, then saving it to
Linear.

Depending on its size (see the Sizing rule in `common.md`), it becomes a
single task (a **Fix** or a **Story**), an epic (an **Epic**: a Linear
issue with one sub-issue per task), or nothing yet (a **Feature**: too big for
one epic, so you recommend planning it as a feature instead).

If the invocation included `--project` and/or `--team` hints, use them when
creating the issues. If a `LINEAR.md` exists, honor its conventions.

Follow the planning rules in `common.md`.

---

## Step 1: Clarifying questions

Before writing anything, ask 3–5 essential clarifying questions where the
initial prompt is ambiguous. Focus on:

- **Problem:** Who has the problem, and why does it matter now?
- **Core behavior:** What must the system do? For a bug, what happens now and
  what should happen instead?
- **Scope:** What is in, and what should it NOT do?
- **Done:** What evidence shows each piece is finished?

Use lettered options and adaptive questioning (see `common.md`). Ask about
prerequisites and manual steps (see `common.md`).

## Step 2: Size the work

Apply the Sizing rule from `common.md`. State the size (Fix, Story, Epic or
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
  offer to start the feature's PRFAQ (`/omniralph-prd prfaq`) or its Plan
  (`/omniralph-prd plan`) from what you've learned.

## Step 4: Tasks (Epic only)

Split the epic into tasks by the Splitting rule, each in the task format (a
fix for a bug, a story otherwise). Present them as `common.md` → "Drafting
tasks with the user" shows.
Don't add a validation task: Omniralph audits the epic against its
requirements before its pull request opens.

## Final step: save to Linear

Once the work item (plus its tasks, if an **Epic**) is written, have the
user review and confirm it is ready to save. Only after they confirm, use the
Linear MCP tools to create the issues, following `common.md` →
"Linear structure reference":

**If an Epic, create an epic with sub-issues:**

- Create a new parent issue.
  - Give it a descriptive but concise title.
  - Use the epic (with the branch line, if any) as the description.
  - Set `blockedBy` for any work item the whole epic waits on.
- Create a sub-issue for each task, in task order.
  - Use the plain task title as the sub-issue title (no drafting label).
  - Use the task's three paragraphs as the description.
  - Set its priority, its `blockedBy` dependencies, the manual label for
    steps for a person, and the bug label for a fix.
- Do the post-creation steps: replace drafting labels with Linear
  identifiers, and verify the blocks relations.

**If a Fix or a Story, create a single task (no sub-issues):**

- Create one new issue with a descriptive but concise title, the task's three
  paragraphs (with the branch line, if any) as its description, the bug label
  for a fix, and `blockedBy` for any work item it waits on.
- Do **not** create any sub-issues.

**If a Feature, create nothing** (unless the user chose to plan its first epic
on its own, which is then saved as above). Leave the recommendation and the
first cut of its epics with the user for feature planning.

## Checklist before creating the issues

- [ ] Asked clarifying questions with lettered options
- [ ] Incorporated the user's answers
- [ ] Sized the whole body of work as a Fix, Story, Epic or Feature, stated
      the reason, and chose the structure accordingly (an epic only for an
      Epic; nothing filed for a Feature)
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

Once the issues are created, tell the user you're done.
