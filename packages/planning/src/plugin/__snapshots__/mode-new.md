<!-- Generated from the omniralph repo (packages/planning/src/plugin, built by scripts/build-prd-plugin.ts). Do not edit by hand: change it in the omniralph repo, and CI publishes it here. -->

# Mode: new

You are planning a piece of software work from scratch, then saving it to
Linear.

Depending on the size, it becomes either an epic (a Linear issue with
one sub-issue per task, when the work is **L** or larger) or a single task, a
story or a fix (when smaller).

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

Apply the Sizing rule from `common.md`. State the size, a one-to-two-sentence
rationale, and the resulting structure (an epic with sub-issues, or a single
story or fix) before continuing.

## Step 3: Write the work item

- **L or larger:** write the epic in the epic format, with its numbered
  requirements.
- **Smaller than L:** write a single task in the task format: its three
  paragraphs, framed as a fix for a bug and as a story otherwise.

## Step 4: Tasks (L or larger only)

Split the epic into tasks by the Splitting rule, each in the task format (a
fix for a bug, a story otherwise). Present them as `common.md` → "Drafting
tasks with the user" shows.
Don't add a validation task: Omniralph audits the epic against its
requirements before its pull request opens.

## Final step: save to Linear

Once the work item (plus its tasks, if **L or larger**) is written, have the
user review and confirm it is ready to save. Only after they confirm, use the
Linear MCP tools to create the issues, following `common.md` →
"Linear structure reference":

**If L or larger, create an epic with sub-issues:**

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

**If smaller than L, create a single task (no sub-issues):**

- Create one new issue with a descriptive but concise title, the task's three
  paragraphs (with the branch line, if any) as its description, the bug label
  for a fix, and `blockedBy` for any work item it waits on.
- Do **not** create any sub-issues.

## Checklist before creating the issues

- [ ] Asked clarifying questions with lettered options
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

Once the issues are created, tell the user you're done.
