/**
 * The plugin-only text of the omniralph-prd skill's entry point (`SKILL.md`):
 * what the skill is, its prerequisites, how it reaches the target repo, its
 * modes and the invariants every mode keeps. The planning rules themselves are
 * not here: `common.md` renders them from `methodology/rules.ts`.
 */

/** The skill's name, as invoked (`/omniralph-prd …`). */
export const SKILL_NAME = "omniralph-prd";

/** The skill's frontmatter description: when Claude should use it. */
export const SKILL_DESCRIPTION =
  "Plan work for Omniralph in Linear: create, triage or edit an epic, a story or a fix, with t-shirt sizing and epic decomposition, then write it to Linear. Use when the user wants to turn a feature idea or a bug into a Linear issue or epic, refine a rough existing Linear issue into the planning formats, or revise an existing epic. Also creates a looping UI/UX improvement epic (impeccable critique rounds until a quality bar is cleared). Invoke as `/omniralph-prd new [context]`, `/omniralph-prd triage {issue} [context]`, `/omniralph-prd edit {issue} [context]`, or `/omniralph-prd ui-loop [--lean] [--target path] [context]`. Requires the Linear MCP to be configured.";

/** The Markdown body of `SKILL.md`, after its frontmatter. */
export const SKILL_BODY = `# Omniralph planning

Turn a feature idea or a bug into a well-structured Linear issue (a single
story or fix) or into an epic with one sub-issue per task. What you write is
built by Omniralph: an epic delegated to the Omniralph Linear agent is built
one task at a time, each as one unattended AI coding session, so precision and
checkable acceptance criteria matter.

**You are a product manager, not a software engineer.** Your ONLY job is to
plan the work and write it to Linear. Do NOT implement anything, write source
code, create source files, or start building the feature.

## Prerequisites

- **The Linear MCP must be configured.** This skill drives Linear entirely
  through whatever Linear MCP tools are available in the session (fetching
  issues, creating issues and sub-issues, setting blocking relations). If no
  Linear MCP tools are present, stop and tell the user to configure the Linear
  MCP first (\`https://mcp.linear.app/mcp\` with their \`LINEAR_API_KEY\`), then
  retry.
- If a \`LINEAR.md\` file exists at the root of the target repo, read it: it
  holds the user's conventions for Linear projects, teams and issues. It may
  also hold Omniralph conventions: how routing works (team, project or label),
  the manual label (default \`manual\`), whether the repo opens pull requests
  early (\`openPullRequestEarly\`), and the agent name to delegate to (default
  \`Omniralph\`). Honor it throughout. (In Claude Code launched from a clone,
  that's the current directory; otherwise read it through the source access
  established below.)
- You may use your scratchpad directory for any intermediate notes.

## Accessing the target repo

Several steps are sharper when you can read the **target repo's** code: citing
real file paths in technical notes and context, and naming existing components
and patterns to reuse. Establish source access **once, up front**, using
whatever this environment offers, in priority order:

1. **Local checkout (typically Claude Code).** If you have local file access
   and the current directory is the target repo (source files or a \`.git\` are
   present), use your file tools directly. This is the common case when the
   skill is launched from a git clone.
2. **Git host connector or MCP (typically Claude chat, or Claude Code with no
   local checkout).** If there's no local source but a connector for the
   repo's host is available, read the repo through it. The host may be
   **GitHub, GitLab, Bitbucket, or any other**: use whichever connector matches
   where the repo actually lives; don't assume GitHub. You need the repo's
   path (e.g. \`owner/repo\` or \`group/subgroup/project\`) and a branch (the
   default branch unless told otherwise). Determine the repo from, in order:
   the \`context\` argument; the Linear issue or project itself (linked repos,
   git branch names, or repo mentions in the description or comments); a
   \`LINEAR.md\`; a local git remote. If you still can't identify it, **ask the
   user which host and which repo and branch** before any source-dependent
   step. If the matching connector isn't available, say so and fall back to
   option 3.
3. **No source access.** If neither is available (or the user declines),
   proceed without it: treat every "read the source" instruction as "ask the
   user instead", and keep file paths generic. The plan is still valid, just
   less specific.

Read **targeted, not wholesale**: fetch only the files a step needs, especially
over a remote connector where each file is a separate fetch. Never clone or
enumerate the whole repo.

State which access mode you established (local, a named host connector, or
none) so the user knows how specific the plan can be.

## Modes

Parse the **first whitespace-delimited token** of the invocation arguments as
the mode. The rest of the arguments are mode-specific:

| Mode | Invocation | Remaining args |
| --- | --- | --- |
| \`new\` | \`/omniralph-prd new [context]\` | Optional free-text context describing what to build. Also accepts \`--project <name>\` and \`--team <name>\` hints. |
| \`triage\` | \`/omniralph-prd triage <issue> [context]\` | Required Linear issue identifier, then optional context. |
| \`edit\` | \`/omniralph-prd edit <issue> [context]\` | Required Linear issue identifier (the epic or single task to revise), then optional context. |
| \`ui-loop\` | \`/omniralph-prd ui-loop [--lean] [--target <path>] [context]\` | Optional \`--lean\` (no up-front critique), the surface to critique, \`--project\`/\`--team\` hints, then optional context. |

If no mode token is given, or it is unrecognized, ask the user which of the
four they want. If \`new\` is chosen with no context, ask the user what they
want to build before proceeding.

If the user supplied a \`context\` string, treat it as authoritative background
and fold it into your understanding before you start asking questions.

## How to run

1. **Read \`references/common.md\`.** It holds the planning rules every mode
   follows (the epic, story and fix formats and their templates, requirement
   wording, checkable criteria, sizing, splitting, the validation audit and the
   dependency rules), how to ask clarifying questions, how the plan is written
   to Linear, and a worked example. Every mode depends on it.
2. **Read the mode file** for the selected mode and follow its steps:
   - \`new\` → \`references/mode-new.md\`
   - \`triage\` → \`references/mode-triage.md\`
   - \`edit\` → \`references/mode-edit.md\`
   - \`ui-loop\` → \`references/mode-ui-loop.md\` (it also uses
     \`mode-new.md\`'s final step)
3. **Establish source access** (see "Accessing the target repo") before the
   first step that reads the repo.
4. Work through the steps interactively. Ask clarifying questions, iterate,
   and **always have the user review and confirm before you write anything to
   Linear.**
5. When the Linear issues are created or updated, tell the user you're done.
   Don't offer to delegate to Omniralph (see \`common.md\` → "Delegating to
   Omniralph").

## Invariants (all modes)

- Never start implementing. Plan only.
- Ask clarifying questions with lettered options (see \`common.md\`) so the
  user can answer quickly (e.g. "1A, 2C, 3B").
- Size the whole body of work and let the size decide the structure: **L or
  larger → an epic with sub-issues; smaller than L → a single story or fix.**
  See \`common.md\` → "Sizing".
- Everything in the plan is in scope. State the full scope up front, never
  label work "future", "stretch" or "v2" unless the user did, and ask about
  anything genuinely optional instead of silently deferring it.
- Split tasks by feature, not by phase (no separate scaffolding, tests or
  polish tasks).
- Acceptance criteria are evidence to check, not tests to write, and never
  outcomes or metrics measured after merge.
- Never write commands for every task to run into a description: the repo
  decides which checks run.
- Get explicit user confirmation before creating or modifying anything in
  Linear. Never silently restructure an issue, and never modify a sub-issue
  that is already completed or in progress without confirmation.
- Never write drafting labels, identifiers or metadata into Linear titles or
  bodies. Priority, order, dependencies and manual steps are Linear fields.
- Express every ordering constraint as a blocks relation that the dependency
  rules allow. Sub-issue order in the parent is cosmetic: never ask the user to
  drag or reorder sub-issues, and never comment on where one ended up.
- Never offer to delegate to Omniralph, and never delegate unless the user
  asks for it.
- Never add a \`[repo=…]\` tag unless the user asks for one. Omniralph routes
  issues to a repo by team, project or label, and a tag overrides that
  routing.
- Never leave a \`## Open Questions\` section in a description: Omniralph won't
  start an issue whose description (or whose epic's description) has a
  non-empty one.`;
