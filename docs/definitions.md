# Playbooks

Every run an agent does (a review, a code question, a story, a PR description…) runs a
**playbook**: one recipe with a role, prompts, a model, tools and what its runs need. Omniralph
ships built-in playbooks; organization admins can add their own. This page explains what goes into
a playbook, what its role fixes, how a run's model and budget are picked, and how custom playbooks
are stored, served and checked. The design is
[ADR 0008](adr/0008-agents-tasks-and-the-harness.md#organization-definitions).

## What a playbook is

A playbook (`Playbook` in `packages/tasks/src/playbooks.ts`) has these fields:

| Field                                         | What it does                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`, `description`                   | `builtin:<name>` for a built-in, a UUID for a custom one. Name up to 200 characters, description up to 2000.                                                                                                                                                                                                                        |
| `role`                                        | What kind of run it is ([roles](#roles)). The role fixes the task type, the triggers and the sink.                                                                                                                                                                                                                                  |
| `systemPrompt`, `systemPromptMode`            | The persona's instructions. `append` adds them to Claude Code's preset; `replace` uses them instead of the preset.                                                                                                                                                                                                                  |
| `systemAppend`                                | Role-specific system text (e.g. an output contract), appended after the system prompt.                                                                                                                                                                                                                                              |
| `promptTemplate`                              | The user prompt, rendered for each run ([templates](#templates)).                                                                                                                                                                                                                                                                   |
| `referenceDocs`                               | Named Markdown documents the run can read. A review renders `rubric/universal.md` and `rubric/languages/<language>.md` (for the diff's languages) as `{{rubric}}`, so a reviewer's rubric is its reference docs.                                                                                                                    |
| `model`, `fallbackModel`                      | A Claude model ID, or null for the Claude Code default; the fallback is used when the model is overloaded. A review playbook sets neither: its review depth sets the model.                                                                                                                                                         |
| `tools`                                       | `builtin` (Claude Code tool names), `agent` (`post_activity`, `ask_permission`, `get_attachment`, and `ship` for coding only), `tracker` (the read-only tracker tools `tracker_get_issue`, `tracker_list_comments`, `tracker_search_issues` and `tracker_get_document`) and `mcpServers` (an installable's servers only).           |
| `toolSettings`                                | Narrow the tools: `shell` (`Bash`), `trackerRead` (the tracker tools, with the `tracker:read` scope), `network` (beyond the control panel).                                                                                                                                                                                         |
| `requires`                                    | Installables and host tools its runs need ([derived requirements](#derived-requirements)).                                                                                                                                                                                                                                          |
| `setupCommands`, `teardownCommands`           | Commands run before and after the session ([below](#setup-and-teardown-commands)).                                                                                                                                                                                                                                                  |
| `outputSchema`                                | A JSON schema of an object the output must match; query roles only, empty for a Markdown answer.                                                                                                                                                                                                                                    |
| `tokenBudget`                                 | A fixed `{ tokens }`, or `null` for **No limit**. A review playbook sets none: its review depth does.                                                                                                                                                                                                                               |
| `coding`                                      | Story and request playbooks only ([coding settings](#coding-settings)): attempts and rounds per story, stall rounds, attempts per run, review and CI fix rounds, push timing, the worktree setup command, preparation, the epic's completed state, branch cleanup and the `prDescriptionPlaybookId` that writes the PR description. |
| `loop`                                        | Looped roles that don't code only ([loop settings](#loop-settings)): `maxIterations` and `stallRounds`.                                                                                                                                                                                                                             |
| `variableLimits`, `maxTurns`, `idleTimeoutMs` | Most characters of a variable rendered into the prompt, most turns, and how long a session may go quiet.                                                                                                                                                                                                                            |

A playbook has no task types, skills, sink, pool, triggers or draft PR timing of its own. Parsing
one that sets them fails with why (`REFUSED_PLAYBOOK_FIELDS`): "A playbook's role sets its task
type; remove taskTypes.", "A playbook's role sets where its output goes; remove sink.", "A run's
pool follows from its role's task type; remove pool.", "A playbook's role sets what starts its
runs; remove triggers." and "The repo's "open PR early" setting decides when the draft PR opens;
remove draftPullRequest." (also under `coding`). `skills`, which the agent never read, is dropped
from old input. An MCP server that isn't an installable's `<package>:<server>` is refused: "Name an
installable's MCP server as <package>:<server>; other MCP servers can't be used."

### Roles

`PLAYBOOK_ROLES` maps each role to what it fixes:

| Role               | Task type | Triggers                                                                                  | Sink             | Built-in only | Loop     |
| ------------------ | --------- | ----------------------------------------------------------------------------------------- | ---------------- | ------------- | -------- |
| `review`           | review    | `pr.updated`, `pr.mention`, `review.rerun`                                                | `review`         |               | `looped` |
| `review-summary`   | review    | `pr.updated`, `pr.mention`, `review.rerun`                                                | `sticky-comment` |               | `none`   |
| `correlation`      | query     | `run.invoked`                                                                             | `run-result`     |               | `none`   |
| `story`            | coding    | `tracker.delegated`                                                                       | `ralph-run`      |               | `looped` |
| `request`          | coding    | `tracker.mention`, `chat.request`, `pr.review-findings`, `pr.ci-failed`, `pr.fix-command` | `ralph-run`      |               | `none`   |
| `pr-description`   | query     | `run.invoked`                                                                             | `run-result`     |               | `none`   |
| `chat-ask`         | query     | `chat.request`                                                                            | `chat-thread`    |               | `none`   |
| `triage`           | query     | `tracker.triage`                                                                          | `triage`         | Yes           | `looped` |
| `learn-rule`       | query     | `finding.dismissed`                                                                       | `learned-rule`   | Yes           | `none`   |
| `reply-to-finding` | query     | `finding.mention`                                                                         | `finding-thread` | Yes           | `none`   |
| `verifier`         | query     | `run.invoked`                                                                             | `run-result`     | Yes           | `none`   |
| `audit`            | query     | `run.invoked`                                                                             | `run-result`     | Yes           | `none`   |

**Loop** says whether a role's runs loop: a worker session does the work, a verifier checks it, and
its findings feed the next iteration until the verifier is satisfied or a cap is reached (see
[loop settings](#loop-settings)). Looping is the default: a new role loops unless it declares
`none`. The single-session roles are the deliberate exceptions: chat answers, requests, finding
replies, learned rules, correlation, PR descriptions and review summaries, plus the loop's own
helpers. `verifier` checks a worker's output (a task against its acceptance criteria) and `audit`
checks a finished epic against its requirements before its PR opens; both are invoked by another
run and hand their output back to it.

A custom playbook can't take a built-in-only role (`CUSTOM_PLAYBOOK_ROLES`). The **task type**
decides how the agent runs it:

| Task type | What a run is                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `query`   | One read-only session; its answer (Markdown, or JSON matching an output schema) goes to the sink.       |
| `review`  | One reviewer of a PR/MR's review run: it reports findings, merged and posted with the other playbooks'. |
| `loop`    | Looped roles that don't code only ([loop settings](#loop-settings)): `maxIterations` and `stallRounds`. |

A run's **pool** (whose concurrency slots it takes) follows from its task type: `long` for coding
runs, `short` for query and review runs. Nobody picks one.

The sinks apply a run's output:

| Sink             | Output                                                                     |
| ---------------- | -------------------------------------------------------------------------- |
| `chat-thread`    | A Markdown answer (no output schema), posted to the chat thread            |
| `finding-thread` | A Markdown answer (no output schema), posted as a reply on the finding     |
| `learned-rule`   | Structured: `{ rule: string \| null }`                                     |
| `triage`         | Structured: the triage result                                              |
| `run-result`     | Any output, handed back to the run that invoked the playbook               |
| `review`         | Findings, saved and posted with the review run                             |
| `sticky-comment` | A summary in one comment per PR/MR, edited in place (findings are dropped) |
| `ralph-run`      | The coding run's result                                                    |

### Model and token budget

A run's model and token cap come from one place, by kind of run (`resolveRunSpec` in
`apps/web/src/lib/runs/resolve.ts`):

| Run       | Model                                                                | Fallback model | Token budget                                          |
| --------- | -------------------------------------------------------------------- | -------------- | ----------------------------------------------------- |
| A review  | The review depth's (Quick, Standard or Deep)                         | None           | The review depth's cap; max files and exploration too |
| Any other | The playbook's `model`, or the Claude Code default when it sets none | The playbook's | The playbook's fixed `tokens`, or **No limit**        |

A review's depth is the repository's, or the one a `@bot review <depth>` mention or a re-run asked
for. A review playbook can't set a model, fallback model or budget ("Review playbooks can't set a
model; the repo's review depth sets it."). No other run depends on a review setting: a repository's depth never
changes a chat answer, a reply or a coding run.

### How a playbook runs

The agent still runs a run spec with an `agent` field (the persona: system prompt, tools, reference
docs, model) and a `task` (task type, triggers, template, settings, sink). `playbookRunSpec` builds
both from a playbook, in one place: the task type, triggers and sink come from the role, a story or
request playbook's coding settings fill in `CODING_DEFAULTS`, and both halves take the playbook's
ID and name. So agents need no change for playbooks. The control panel looks playbooks up
through a `PlaybookSource` (`getPlaybook`, `organizationPlaybooks` in
`apps/web/src/lib/playbooks/index.ts`); a job's `task_id` holds the playbook ID.

### Loop settings

A looped role that doesn't code (`review`, `triage`; `roleHasLoopSettings`) takes a `loop` block.
Each limit it leaves out has its default (`LOOP_DEFAULTS` in `packages/tasks/src/playbooks.ts`);
`playbookLoopSettings` reads them:

| Field           | Default | What it does                                                                                    |
| --------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `maxIterations` | 5       | Most worker-then-verifier iterations a run gets (1 to 50).                                      |
| `stallRounds`   | 2       | Iterations in a row whose reported metric doesn't beat its best before the run stops (1 to 20). |

A story playbook loops by its [coding settings](#coding-settings) instead (`maxAttemptsPerStory`,
`maxRoundsPerStory`, `stallRounds`), so a `loop` block on it is refused with "A story playbook
loops by its coding settings; remove loop.". On a single-session role it is refused with "A
chat-ask playbook doesn't loop: its runs are one session. Remove loop.". The playbook editor
shows a **Loop** card for every looped role (the story's attempts, rounds and stall rounds, or
another role's iterations and stall rounds, each with what it does) and none for the rest; a
playbook's page shows the same settings read-only.

The control panel's loop driver (`apps/web/src/lib/runs/loop.ts`, [ADR 0013](adr/0013-run-loop.md))
runs these loops. `startLoop` copies the playbook's limits onto the run's first iteration (a
playbook edit doesn't change a running loop) and starts its worker; once the worker finishes, a
verifier session checks its output and answers with a verdict (`converged`, a `summary`, the
`findings` the next iteration should address, and optionally a progress `metric`). The run stops
when the verifier reports convergence, after `maxIterations`, or when the metric hasn't beaten its
best for `stallRounds` iterations; otherwise the findings become the next worker's input. A failed
worker or verifier, or a verifier answer that isn't a verdict, stops the loop as failed. Every
iteration is stored in `run_iterations` (its number, status, verdict, summary, findings, metric,
worker and verifier jobs, timestamps, and on the last one why the loop stopped) and listed in the
run detail's `iterations` as it changes.

### Coding settings

A story or request playbook's `coding` holds everything about how its runs work, apart from the
repository's own coding policy (on/off, work item match, extra instructions, open PR early, history
rewrite, and responding to reviews and CI; see [Linear](linear.md#4-configure-routing), the first tracker adapter). Each field
it leaves out has its default (`CODING_DEFAULTS` in `packages/tasks/src/definitions.ts`), which is
what the built-ins use:

| Field                                                                            | Default               | What it does                                                                                                                                                      |
| -------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxAttemptsPerStory`, `maxRoundsPerStory`, `stallRounds`, `maxIterationsPerRun` | 3, 8, 3, 50           | How often a story is tried, how many review-loop rounds it gets, how many rounds without a better metric, and story attempts per run.                             |
| `maxReviewRounds`, `maxFixRounds`                                                | 3, 3                  | How many reviews and failed CI runs of a lane's PR become requests. The request playbook's apply (it runs the rounds); the repo API reports the story playbook's. |
| `pushTiming`                                                                     | `per-story`           | When the branch is pushed: after each story, or once at the `end`.                                                                                                |
| `runPrdQualityGates`                                                             | on                    | Also run the PRD's `## Quality Gates`.                                                                                                                            |
| `worktreeSetupCommand`                                                           | none                  | Run once in a fresh branch worktree (e.g. `pnpm install`).                                                                                                        |
| `allowPreparation`                                                               | on                    | Offer to run a manual story's preparation commands.                                                                                                               |
| `epicCompletedState`                                                             | none                  | The state the epic moves to when every story is complete.                                                                                                         |
| `cleanupMergedWorktrees`, `unmergedBranchTimeoutMinutes`                         | on, 60                | Remove the worktree and local branch after the merge, and how long to wait for an answer about unmerged commits.                                                  |
| `prDescriptionPlaybookId`                                                        | `builtin:describe-pr` | The `pr-description` playbook that writes the PR title and description.                                                                                           |

The commands that must pass after every story and request aren't a playbook setting: they are the
repo's **checks**, set on its Coding card (`repositories.checks`; see
[Linear](linear.md#4-configure-routing)). A story or request job runs its lane repository's checks
after the session, in order, then the PRD's `## Quality Gates` when `runPrdQualityGates` is on
(each command runs once); a failing one sends its output back for the next attempt. A story in
another repo's lane runs that repo's checks. Saving a playbook whose `coding` still sets
`verifyCommands` is refused with "Checks are set per repo, on its Coding card; remove
verifyCommands."; a playbook stored with them reads without them.

The control panel reads them with `codingSettings` (`apps/web/src/lib/ralph/coding.ts`): the story
playbook's for the run as a whole, the request playbook's for requests and their rounds. The agent
reads the worktree setup command and the model from the run spec.

## Built-in playbooks

The built-ins are in `packages/tasks/src/builtin/` and registered in `packages/tasks/src/builtins.ts`
(`BUILTIN_PLAYBOOKS`). Each keeps the ID its task had; the personas they share (the reviewer, the
engineer) are folded into each playbook.

| Playbook                     | Role               | Model               | Token budget |
| ---------------------------- | ------------------ | ------------------- | ------------ |
| `builtin:review-pr`          | `review`           | The review depth's  | The depth's  |
| `builtin:summarize-pr`       | `review-summary`   | The review depth's  | The depth's  |
| `builtin:correlate-findings` | `correlation`      | `claude-sonnet-5-5` | 100,000      |
| `builtin:implement-story`    | `story`            | `opus`              | No limit     |
| `builtin:handle-request`     | `request`          | `opus`              | No limit     |
| `builtin:describe-pr`        | `pr-description`   | `opus`              | No limit     |
| `builtin:ask-about-code`     | `chat-ask`         | `claude-sonnet-5-5` | 50,000       |
| `builtin:triage`             | `triage`           | `opus`              | No limit     |
| `builtin:learn-rule`         | `learn-rule`       | `claude-sonnet-5-5` | 5,000        |
| `builtin:reply-to-finding`   | `reply-to-finding` | `claude-sonnet-5-5` | 20,000       |

`builtinProblems` checks the registry (each parses, has a unique `builtin:` ID, a valid template
and valid variable limits, and its coding settings combine), and a snapshot test checks each
built-in renders the same system prompt, template, tools and model as the agent and task it
replaced.

## Custom playbooks

An organization's own playbooks are rows of `playbooks` (`id` a UUID, `organization_id`, `name`,
`role`, `definition` with every other field, and `requirements`, the
[derived requirements](#derived-requirements) stored when it was saved). A row that no longer
parses as a `Playbook`, or has a built-in-only role, doesn't resolve and its runs fail. Built-in
playbooks stay in code and can't be edited: clone one to change it.

They are served by the Playbooks API (`apps/web/src/app/api/ui/playbooks`), which calls
`loadPlaybookList`, `loadPlaybookDetail`, `createPlaybook`, `updatePlaybook`, `clonePlaybook` and
`deletePlaybook` in `apps/web/src/lib/playbooks/manage.ts`. Paths carry a `builtin:` ID
URI-encoded (`builtin%3Areview-pr`).

| Request                              | Who     | What it does                                                                                                                                                                                                                                   |
| ------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/ui/playbooks`              | Members | The built-ins, then the organization's own by name: `id`, `name`, `description`, `role`, `builtin`, `model` and `usedBy` (repo bindings, chat settings and playbooks naming it).                                                               |
| `GET /api/ui/playbooks/{id}`         | Members | One playbook (`playbook`, `builtin`, `requirements`, `usedBy`, and `tokenBudgetLabel`: `No limit` for a null budget). Another organization's, or an unknown ID, is 404.                                                                        |
| `GET /api/ui/playbooks/form-options` | Admins  | What the editor offers: the custom roles, the models the organization's non-revoked agents report, the built-in, agent and tracker tool names, the reported installables' MCP servers (`<package>:<server>`) and the PR description playbooks. |
| `POST /api/ui/playbooks`             | Admins  | Creates one from the body (a playbook without `id`); answers `{ ok, id, detail, summary }` (its detail and list row).                                                                                                                          |
| `PUT /api/ui/playbooks/{id}`         | Admins  | Replaces a custom playbook; answers `{ ok, id, detail, summary }`. A built-in is refused with 409 `builtin_read_only`.                                                                                                                         |
| `POST /api/ui/playbooks/{id}/clone`  | Admins  | Copies a built-in or custom playbook into a new one named `<name> copy`; answers `{ ok, id, detail, summary }`. A built-in-only role can't be copied.                                                                                          |
| `DELETE /api/ui/playbooks/{id}`      | Admins  | Deletes a custom playbook, unless it's [in use](#delete-refusals). A built-in is refused with 409 `builtin_read_only`.                                                                                                                         |

Every save, clone and delete publishes the `playbooks` settings change event with the playbook as
its subject. A playbook's role can't change on **Save** while anything
[uses it](#delete-refusals), since whatever uses it picked it for its role. A custom playbook may
name a built-in PR description playbook.

Admins edit them in Settings › Advanced › Playbooks: **New playbook**, and on a playbook's page
**Clone** (the copy opens in the editor) and, for a custom one, ⋯ **Edit** and **Delete…**.

### Setup and teardown commands

Setup commands run in order in the working directory before the session: **Name** (lowercase
letters, digits and `_`, unique), **Command** (`sh -c`), **Timeout (seconds)** (default 300, at
most 1800), **Output cap (bytes)** (default 20,000, at most 200,000), **Fence** (the info string
around the output, e.g. `json`) and **Optional**. Each one's stdout is the variable
`{{setup.<name>}}`. A failing command fails the run, unless it's optional: then its variable holds
a one-line failure note. Commands run without either job token in their environment. Teardown
commands run in order after the session, whatever happened; their output is logged and a failure
never fails the run. At most 20 of each.

## Templates

A prompt template is a logic-less subset of [Mustache](https://mustache.github.io/mustache.5.html):

| Syntax                     | Meaning                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `{{name}}`, `{{pr.title}}` | A variable (dotted names reach into objects).                                               |
| `{{#name}}…{{/name}}`      | A section: rendered when `name` is set and not empty or false; repeated for each list item. |
| `{{^name}}…{{/name}}`      | An inverted section: rendered when `name` is unset, empty or false.                         |
| `{{.}}`                    | The current item inside a section over a list.                                              |
| `{{! comment }}`           | A comment, not rendered.                                                                    |
| `\{{`                      | A literal `{{` (e.g. GitHub Actions' `${{ }}`).                                             |

Partials, lambdas, delimiter changes, `{{{triple}}}` and `{{& name}}` are errors. Nothing is
HTML-escaped. Section, closing and comment tags alone on their line remove the whole line.

Lists are written as sections: the catalog's `stories.items.identifier` is used as
`{{#stories}}{{#items}}- {{identifier}}{{/items}}{{/stories}}`.

### Variables and where they come from

Every variable has a **source**:

- **trigger**: data of the event that started the run, e.g. `repository`, `pr.number`, `pr.title`,
  `pr.body` (PR/MR triggers), `finding.title`, `finding.body` (`finding.*`), `dismissal.note`
  (`finding.dismissed`), `chat.context` (`chat.request`), `issue.title`, `issue.description`
  (tracker triggers), `epic.prd`, `stories`, `requests` (coding triggers), `story.*`
  (`tracker.delegated` only), `reviewRun.tasks` (`run.invoked`).
- **task type**: what the agent computes while preparing the run, e.g. `diff`, `plan`, `rubric`,
  `depth`, `repositoryRules`, `previousFindings`, `conventions` (review), `question`, `hunk`,
  `checkout`, `conventions` (query), `progress`, `feedback`, `attempt`, `today` (coding).
- **setup**: `setup.<name>`, the output of the playbook's setup command `<name>`.

A playbook can use a variable only when its role's task type provides it, or **every one** of its
role's triggers does: a template is checked once per trigger. The full catalog, with what each
variable holds, is `VARIABLES` in `packages/tasks/src/variables.ts`; the built-in playbooks'
templates (`packages/tasks/src/builtin/`) are worked examples.

### Trust and fencing

Each variable is **trusted** (IDs, numbers, names Omniralph controls) or **untrusted** (anything a
person or a model outside the run wrote: PR bodies, diffs, findings, chat messages, tracker text,
setup command output). The renderer fences every untrusted value itself, in a code fence longer
than any backtick run inside it (with the variable's info string, e.g. `diff` or `markdown`, or
the setup command's **Fence**), or between `<tag>` lines for tracker text. A template can't forget
to fence user input and can't opt out, so write `{{pr.body}}` on its own line rather than inside
your own fence. A playbook's `variableLimits` cut over-long values (marked `[… truncated]`)
before fencing.

## Save-time validation

Create, update and clone validate the playbook with `validatePlaybookAgainst`
(`apps/web/src/lib/playbooks/validation.ts`): the `Playbook` schema, then `validateTaskDefinition`
(`packages/tasks/src/validate.ts`) on the run spec it becomes, against the organization's
playbooks and the control panel's sinks. A rejected save answers 400 "Fix the highlighted fields."
with each error under its playbook field; nothing is stored. The rules, with the field each error
appears on and an example message:

| Rule                                                                                          | Field                                   | Example error                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| The schema: required fields, lengths, ranges, known values                                    | The field                               | `name`: Too small: expected string to have >=1 characters / `setupCommands.0.name`: Use lowercase letters, digits and \_, starting with a letter |
| No field the role sets (`REFUSED_PLAYBOOK_FIELDS`)                                            | The field                               | A playbook's role sets where its output goes; remove sink.                                                                                       |
| A role a custom playbook can take                                                             | `role`                                  | Only a built-in playbook can be a triage playbook.                                                                                               |
| MCP servers are an installable's                                                              | `tools.mcpServers.<i>`                  | Name an installable's MCP server as <package>:<server>; other MCP servers can't be used.                                                         |
| Agent tools are allowed for the role's task type                                              | `tools.agent`                           | review runs can't use the agent tool ship.                                                                                                       |
| Setup command names are unique                                                                | `setupCommands.<i>.name`                | Setup command name semgrep is used twice                                                                                                         |
| Only query roles have an output schema; only story and request playbooks have coding settings | `outputSchema`, `coding`                | A review playbook can't declare an output schema.                                                                                                |
| Only a looped role that doesn't code has a loop block                                         | `loop`                                  | A chat-ask playbook doesn't loop: its runs are one session. Remove loop.                                                                         |
| A review playbook sets no model, fallback model or token budget                               | `model`, `fallbackModel`, `tokenBudget` | Review playbooks can't set a model; the repo's review depth sets it.                                                                             |
| The template parses                                                                           | `promptTemplate`                        | Line 1, column 7: Section `pr.title` is never closed.                                                                                            |
| Every variable exists for the role's task type and every one of its triggers                  | `promptTemplate`                        | `{{pr.titel}}` isn't a variable query tasks can use. / `{{diff}}` isn't available for chat.request.                                              |
| A request playbook only uses `epic.prd` and `story.*` inside an optional section              | `promptTemplate`                        | A request (chat.request) may have no epic or story: put `{{epic.prd}}` in an optional section (e.g. `{{#epic.prd}}…{{/epic.prd}}`).              |
| A variable limit names a variable the playbook can use                                        | `variableLimits.<name>`                 | This task can't use hunk.                                                                                                                        |
| The output schema is an object schema the agent can check output against                      | `outputSchema`                          | The output must be an object: set "type": "object".                                                                                              |
| A correlation or PR description playbook outputs `{ findings, summary }` / `{ title, body }`  | `outputSchema`                          | … has no output schema: a PR description task outputs { title, body }.                                                                           |
| The role's sink takes the output (a Markdown answer, or structured output it accepts)         | `role`                                  | The chat-thread sink takes a Markdown answer: remove the output schema.                                                                          |
| The PR description playbook exists and is a `pr-description` playbook                         | `coding.prDescriptionPlaybookId`        | There is no task 0b7c….                                                                                                                          |

Every built-in a custom playbook's role allows passes the same validation as a clone (a test in
`apps/web/src/lib/playbooks/validation.test.ts`), so a cloned built-in saves unchanged.

## Derived requirements

What a playbook's runs need from an agent is derived from it (`playbookRequirements`; for a custom
one, also stored with its row on save and returned as `requirements` by `GET /api/ui/playbooks/{id}`):

- **Minimum agent version**: the highest of the release that runs the role's task type (query
  0.9.0, review 0.10.0, coding 0.11.0), 0.10.0 when it has setup or teardown commands, 2.1.0
  (`AGENT_VERSION_FOR_TRACKER`) when it is a coding playbook or turns on
  `toolSettings.trackerRead` (the tracker protocol, [ADR 0012](adr/0012-tracker-layer.md)), and
  any later release a variable its template uses needs.
- **Installables** and **host tools**: the playbook's `requires` (`requires.installables`, npm
  package names, and `requires.hostTools`, executable names the agents set paths for), plus every
  installable whose MCP servers its tools list as `<package>:<server>` (e.g.
  `@omniralph/code-graph:graph`).

Every job of the playbook carries the minimum version (`jobs.min_agent_version`), so only
agents on that release or later claim it; older ones leave it queued. Built-ins carry no stored
requirements; their jobs set the version their task type needs. Jobs also carry the installables
and host tools (`jobs.required_installables`, `jobs.required_host_tools`), derived from the
playbook as it is when the job is enqueued: only an agent whose heartbeat reports every
installable and every host tool with a path claims it.

On the agent, a setup or teardown command whose first word is one of the playbook's host tools runs
that tool's absolute path on the agent, and one whose first word names a command of a required
installable runs that command's `bin` inside the installed package, never an executable of the
same name the checkout puts on the run's `PATH`. Other commands run as written. The installable
MCP servers the playbook lists are attached to its sessions from the installed packages (their tools
are `mcp__<package>_<server>__<tool>`, with every character but letters, digits, `_` and `-`
replaced by `_` and no leading `_`, e.g. `mcp__omniralph_code-graph_graph__<tool>`). The skills
of every required installable are loaded into the run's sessions as an agent-written plugin
(`<package>` lowercased with other characters as `-`, e.g. `omniralph-code-graph:<skill>`); an
installed installable the run doesn't require adds none. A run whose
host tool or installable is missing on the agent that claimed it is retried after a minute.

Each installable gets cache directories on the agent, passed to its commands (as setup or
teardown commands) and MCP servers: `OMNIRALPH_CACHE_DIR`, the run's repository cache
(`<dataDir>/cache/<package>/<repository id>/`), and on a PR trigger (`pr.updated`, `pr.mention`,
`review.rerun`, `finding.mention`, `pr.review-findings`, `pr.ci-failed`, `pr.fix-command`)
`OMNIRALPH_PR_CACHE_DIR`, the PR's cache (`<dataDir>/pr-cache/<package>/<repository id>/<number>/`).
The PR caches are a separate tree, never inside a repository cache, so data derived from an
untrusted PR must only go to the PR cache, which other runs never read. The installable owns
what's inside (including keying by commit, e.g. an index per base commit). Caches are
best-effort: nothing is stored in the control panel, and a run on another agent starts cold.
A run without a repository gets neither variable. Writing, installing and locking down
installables and host tools is covered in [installables.md](installables.md).

## Delete refusals

`DELETE /api/ui/playbooks/{id}` (custom playbooks only) is refused with 409 `playbook_in_use`, with
nothing deleted, while the playbook is used (`findPlaybookReferrers` in
`apps/web/src/lib/playbooks/referrers.ts`); the error names each user: "Security review can't be
deleted while it's used by repo acme/app (review), the chat ask about code playbook, chat channel
Acme Slack › C0123ABCD (start work), playbook Ship it (PR description)." Repo roles are review,
correlation, story and request. It's refused the same way while a run of it is queued or running:
"Security review can't be deleted while a run of it is queued or running." A built-in is refused
with 409 `builtin_read_only`: "Built-in playbooks can't be changed; clone one to make your own."

Change or remove the settings named, wait for the runs, then delete.

## Where custom playbooks can be chosen

Each binding takes playbooks of the roles listed (`REPOSITORY_BINDING_ROLES`), built-in or the
organization's own, and the server checks each pick on save: another organization's playbook, an
unresolvable one or one of another role is refused under the field. A repo's bindings are its
Repos page's Playbooks card, saved together by admins with `PUT /api/ui/repositories/{id}/playbooks`
(`{ bindings: { review, correlation, story, request } }`; every binding is given).

| Setting                                                                                                  | Roles                      |
| -------------------------------------------------------------------------------------------------------- | -------------------------- |
| `bindings.review` of `PUT /api/ui/repositories/{id}/playbooks` (run in parallel per review)              | `review`, `review-summary` |
| `bindings.correlation` of `PUT /api/ui/repositories/{id}/playbooks`                                      | `correlation`              |
| `bindings.story` of `PUT /api/ui/repositories/{id}/playbooks`                                            | `story`                    |
| `bindings.request` of `PUT /api/ui/repositories/{id}/playbooks`                                          | `request`                  |
| `ask` of `PUT /api/ui/integrations/chat-tasks` or a channel override ([chat.md](chat.md#chat-playbooks)) | `chat-ask`                 |
| `startWork` of `PUT /api/ui/integrations/chat-tasks` or a channel override                               | `request`                  |
| A story or request playbook's `coding.prDescriptionPlaybookId`                                           | `pr-description`           |

A binding change records one `repository.playbooks` change-history entry and publishes the repo's
change event. Changes apply to the next run; runs already started keep the playbook they were claimed with.

## Walkthrough: a second review playbook

Add a security reviewer next to the default review, with its own rubric:

1. **Clone the built-in.** `POST /api/ui/playbooks/builtin%3Areview-pr/clone` answers the copy's
   `id`.
2. **Give it its rubric.** `GET /api/ui/playbooks/{id}`, then `PUT` it back named
   `Security review` with its `referenceDocs` rewritten: `rubric/universal.md` is the rubric every
   review gets (with `rubric/languages/<language>.md` per language in the diff). Rewrite it around
   what this reviewer looks for (e.g. injection, authz, secrets), and adjust the `promptTemplate`
   if you like (it is checked against the review variables for `pr.updated`, `pr.mention` and
   `review.rerun`).
3. **Bind it to a repo.** `PUT /api/ui/repositories/{id}/playbooks` with the repo's bindings and
   `review: ["builtin:review-pr", "<id>"]`.

The next push or `@omniralph review` on a PR/MR of that repository starts one review run with both
playbooks in parallel; the correlation playbook merges findings both reported, and the posted
review's inline comments name the playbook(s) that found each issue. Nothing is deployed and no
agent changes, as long as it's on a release the playbook's [requirements](#derived-requirements)
ask for.
