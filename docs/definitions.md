# Playbooks

Every run a harness does (a review, a code question, a story, a PR description…) runs a
**playbook**: one recipe with a role, prompts, a model, tools and what its runs need. Omniralph
ships built-in playbooks; organization admins can add their own. This page explains what goes into
a playbook, what its role fixes, how a run's model and budget are picked, and how custom playbooks
are edited and checked today. The design is
[ADR 0008](adr/0008-agents-tasks-and-the-harness.md#organization-definitions).

## What a playbook is

A playbook (`Playbook` in `packages/tasks/src/playbooks.ts`) has these fields:

| Field                                         | What it does                                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`, `description`                   | `builtin:<name>` for a built-in, a UUID for a custom one. Name up to 200 characters, description up to 2000.                                                                                                         |
| `role`                                        | What kind of run it is ([roles](#roles)). The role fixes the task type, the triggers and the sink.                                                                                                                   |
| `systemPrompt`, `systemPromptMode`            | The persona's instructions. `append` adds them to Claude Code's preset; `replace` uses them instead of the preset.                                                                                                   |
| `systemAppend`                                | Role-specific system text (e.g. an output contract), appended after the system prompt.                                                                                                                               |
| `promptTemplate`                              | The user prompt, rendered for each run ([templates](#templates)).                                                                                                                                                    |
| `referenceDocs`                               | Named Markdown documents the run can read. A review renders `rubric/universal.md` and `rubric/languages/<language>.md` (for the diff's languages) as `{{rubric}}`, so a reviewer's rubric is its reference docs.     |
| `model`, `fallbackModel`                      | A Claude model ID, or null for the Claude Code default; the fallback is used when the model is overloaded. A review playbook sets no model: its review depth does.                                                   |
| `tools`                                       | `builtin` (Claude Code tool names), `harness` (`post_activity`, `ask_permission`, `get_attachment`, and `ship` for coding only), `linear` (read-only Linear tools) and `mcpServers` (an installable's servers only). |
| `toolSettings`                                | Narrow the tools: `shell` (`Bash`), `linearRead` (the Linear tools), `network` (beyond the control panel).                                                                                                           |
| `requires`                                    | Installables and host tools its runs need ([derived requirements](#derived-requirements)).                                                                                                                           |
| `setupCommands`, `teardownCommands`           | Commands run before and after the session ([below](#setup-and-teardown-commands)).                                                                                                                                   |
| `outputSchema`                                | A JSON schema of an object the output must match; query roles only, empty for a Markdown answer.                                                                                                                     |
| `tokenBudget`                                 | A fixed `{ tokens }`, or `null` for **No limit**. A review playbook sets none: its review depth does.                                                                                                                |
| `coding`                                      | Story and request playbooks only: attempts and rounds per story, stall rounds, attempts per run, review and CI fix rounds, push timing and the `prDescriptionPlaybookId` that writes the PR description.             |
| `variableLimits`, `maxTurns`, `idleTimeoutMs` | Most characters of a variable rendered into the prompt, most turns, and how long a session may go quiet.                                                                                                             |

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

| Role               | Task type | Triggers                                                                                 | Sink             | Built-in only |
| ------------------ | --------- | ---------------------------------------------------------------------------------------- | ---------------- | ------------- |
| `review`           | review    | `pr.updated`, `pr.mention`, `review.rerun`                                               | `review`         |               |
| `review-summary`   | review    | `pr.updated`, `pr.mention`, `review.rerun`                                               | `sticky-comment` |               |
| `correlation`      | query     | `run.invoked`                                                                            | `run-result`     |               |
| `story`            | coding    | `linear.delegated`                                                                       | `ralph-run`      |               |
| `request`          | coding    | `linear.mention`, `chat.request`, `pr.review-findings`, `pr.ci-failed`, `pr.fix-command` | `ralph-run`      |               |
| `pr-description`   | query     | `run.invoked`                                                                            | `run-result`     |               |
| `chat-ask`         | query     | `chat.request`                                                                           | `chat-thread`    |               |
| `triage`           | query     | `linear.triage`                                                                          | `triage`         | Yes           |
| `learn-rule`       | query     | `finding.dismissed`                                                                      | `learned-rule`   | Yes           |
| `reply-to-finding` | query     | `finding.mention`                                                                        | `finding-thread` | Yes           |

A custom playbook can't take a built-in-only role (`CUSTOM_PLAYBOOK_ROLES`). The **task type**
decides how the harness runs it:

| Task type | What a run is                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `query`   | One read-only session; its answer (Markdown, or JSON matching an output schema) goes to the sink.       |
| `review`  | One reviewer of a PR/MR's review run: it reports findings, merged and posted with the other playbooks'. |
| `coding`  | A session that changes code in a worktree and ships it (ralph's stories and requests).                  |

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
| A review  | The review depth's (Quick, Standard or Deep)                         | The playbook's | The review depth's cap; max files and exploration too |
| Any other | The playbook's `model`, or the Claude Code default when it sets none | The playbook's | The playbook's fixed `tokens`, or **No limit**        |

A review's depth is the repository's, or the one a `@bot review <depth>` mention or a re-run asked
for. A review playbook can't set a model or budget ("Review playbooks can't set a model; the repo's
review depth sets it."). No other run depends on a review setting: a repository's depth never
changes a chat answer, a reply or a coding run.

### How a playbook runs

The harness still runs a run spec with an `agent` (the persona: system prompt, tools, reference
docs, model) and a `task` (task type, triggers, template, settings, sink). `playbookRunSpec` builds
both from a playbook, in one place: the task type, triggers and sink come from the role, a story or
request playbook's coding settings fill in `CODING_DEFAULTS`, and both halves take the playbook's
ID and name. So harnesses need no change for playbooks. The control panel looks playbooks up
through a `PlaybookSource` (`getPlaybook`, `organizationPlaybooks` in
`apps/web/src/lib/definitions/index.ts`); a job's `task_id` holds the playbook ID.

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

Until playbooks get their own storage and page, a custom playbook is a **task** on an **agent**,
edited under **Settings › Agents** (`/settings/agents`) and **Settings › Tasks**
(`/settings/tasks`), and read as one playbook (`customPlaybook` in
`apps/web/src/lib/definitions/custom-playbooks.ts`): the agent's persona with the task's prompt and
settings, model = the task's **Model override**, else the agent's. Its role comes from the task's
type, sink and triggers (a `run-result` query task is a correlation or a PR description by its
output schema; a coding task a request when it accepts every request trigger, else a story). A task
that fits no role, or only a built-in-only one, doesn't resolve and its runs fail.

On those pages, each built-in playbook shows as a built-in task on a built-in agent of the same ID
(its persona). Members can list and view everything (`/settings/agents/<id>`,
`/settings/tasks/<id>`); only admins create, edit, clone and delete. Built-ins can't be edited:
**Clone** one to change it. A custom task may run on a built-in's persona, and a custom coding task
may name a built-in PR description task.

**Clone** on any page copies the agent or task into a new custom one with a new UUID, named
`<name> (copy)`, and opens its edit page. A cloned task keeps the source's agent (clone the agent
too, then pick the copy, to change the persona). The copy is validated like a save, and its
[requirements](#derived-requirements) are derived again; a custom task that no longer validates
can't be cloned until it's fixed: "Nightly audit can't be cloned until it's fixed: …".

### The agent form

| Field                             | What it does                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**, **Description**         | Required name up to 200 characters; description up to 2000, shown in lists.                                                                       |
| **Model**, **Fallback model**     | A Claude model ID used when the task sets no **Model override**; empty for the Claude Code default. Never a review's: its review depth sets that. |
| **System prompt** › **Mode**      | **Append** to Claude Code's preset, or **Replace** it.                                                                                            |
| **System prompt**                 | The persona's instructions.                                                                                                                       |
| **Tools** › **Claude Code tools** | Claude Code tool names (`Read`, `Grep`, `Glob`…). The task's type and tool settings narrow them further (e.g. `Bash` only with **Shell**).        |
| **Tools** › **Harness tools**     | `post_activity`, `ask_permission`, `get_attachment` (any type) and `ship` (coding only).                                                          |
| **Tools** › **Linear tools**      | Read-only Linear tools; the task must also enable **Linear read access**.                                                                         |
| **Tools** › **MCP servers**       | An installable's MCP servers as `<package>:<server>` (its tasks then require that installable).                                                   |
| **Reference docs**                | Named Markdown documents the run can read.                                                                                                        |

### The task form

Cards appear for the chosen task type only (**Output schema** for query tasks, **Coding** for
coding tasks).

| Field                                | What it does                                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**, **Description**            | As for agents.                                                                                                                                                                         |
| **Task type**                        | `query`, `review` or `coding`. It can't change while something [uses the task](#delete-refusals).                                                                                      |
| **Agent**                            | A built-in persona or a custom agent.                                                                                                                                                  |
| **Triggers**                         | The events that may start the task, among those its type accepts; the role they make decides what really starts its runs.                                                              |
| **Prompt template** › **Template**   | The user prompt ([templates](#templates)).                                                                                                                                             |
| **Setup commands**                   | See [below](#setup-and-teardown-commands).                                                                                                                                             |
| **Teardown commands**                | See [below](#setup-and-teardown-commands).                                                                                                                                             |
| **Tool settings**                    | **Shell (Bash)** (query tasks only), **Linear read access**, **Network access beyond the control panel**.                                                                              |
| **Requirements**                     | **Installables** (npm package names) and **Host tools** (names from **Settings › Harnesses › Host tools**) the task's runs need.                                                       |
| **Output schema** (query)            | A JSON schema of an object the output must match; empty for a Markdown answer.                                                                                                         |
| **Coding** › **Push**                | **After each story** or **Once at the end**. When the draft PR opens is the repository's "open PR early" setting.                                                                      |
| **Coding** › **PR description task** | The query task that writes the PR title and description (default `builtin:describe-pr`).                                                                                               |
| **Coding** › limits                  | **Attempts per story** (default 3), **Story attempts per run** (50), **Review fix rounds** and **CI fix rounds** (20 each, capping the repository's settings). Empty uses the default. |
| **Running** › **Sink**               | What applies the run's output; only sinks of the task type are listed.                                                                                                                 |
| **Running** › **Model override**     | Wins over the agent's model. Review tasks can't set one (their review depth does).                                                                                                     |
| **Running** › **Token budget**       | A fixed number of **Tokens**, or **No limit** (stored as `null`). Review tasks can't set one.                                                                                          |

A custom task also keeps fields the form doesn't show when it was cloned from a built-in with them
(`systemAppend`, `variableLimits`, `maxTurns`, `idleTimeoutMs`).

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
  (Linear triggers), `epic.prd`, `stories`, `requests` (coding triggers), `story.*`
  (`linear.delegated` only), `reviewRun.tasks` (`run.invoked`).
- **task type**: what the harness computes while preparing the run, e.g. `diff`, `plan`, `rubric`,
  `depth`, `repositoryRules`, `previousFindings`, `conventions` (review), `question`, `hunk`,
  `checkout`, `conventions` (query), `progress`, `feedback`, `attempt`, `today` (coding).
- **setup**: `setup.<name>`, the output of the playbook's setup command `<name>`.

A playbook can use a variable only when its role's task type provides it, or **every one** of its
role's triggers does: a template is checked once per trigger. The full catalog, with what each
variable holds, is `VARIABLES` in `packages/tasks/src/variables.ts`; the built-in playbooks'
templates (`packages/tasks/src/builtin/`) are worked examples.

### Trust and fencing

Each variable is **trusted** (IDs, numbers, names Omniralph controls) or **untrusted** (anything a
person or a model outside the run wrote: PR bodies, diffs, findings, chat messages, Linear text,
setup command output). The renderer fences every untrusted value itself, in a code fence longer
than any backtick run inside it (with the variable's info string, e.g. `diff` or `markdown`, or
the setup command's **Fence**), or between `<tag>` lines for Linear text. A template can't forget
to fence user input and can't opt out, so write `{{pr.body}}` on its own line rather than inside
your own fence. A playbook's `variableLimits` cut over-long values (marked `[… truncated]`)
before fencing.

## Save-time validation

**Save** (and **Create**, and **Clone** of a task) validates the agent with `validateCustomAgent`
(`apps/web/src/lib/definitions/validation.ts`) and the task with `validateTaskDefinition`
(`packages/tasks/src/validate.ts`), against the organization's agents and tasks and the control
panel's sinks. The forms send them to the `/api/ui/agents` and `/api/ui/tasks` handlers, which call
`createAgent`, `updateAgent`, `cloneAgent` (and the same for tasks: `createTask`, `updateTask`,
`cloneTask`) in `apps/web/src/lib/definitions/manage.ts`, and **Delete** calls `deleteAgent` /
`deleteTask`. A rejected save says "Fix the highlighted fields." and shows each error under its
field; nothing is stored. The rules, with the field each error appears on and an example message:

| Rule                                                                                                       | Field                    | Example error                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| The schema: required fields, lengths, ranges, known values                                                 | The field                | `name`: Too small: expected string to have >=1 characters / `setupCommands.0.name`: Use lowercase letters, digits and \_, starting with a letter |
| An agent's MCP servers are an installable's                                                                | `tools.mcpServers.<i>`   | Name an installable's MCP server as <package>:<server>; other MCP servers can't be used.                                                         |
| Setup command names are unique                                                                             | `setupCommands.<i>.name` | Setup command name semgrep is used twice                                                                                                         |
| Only query tasks have an output schema                                                                     | `outputSchema`           | outputSchema is only allowed on query tasks                                                                                                      |
| Only coding tasks have coding fields                                                                       | The field                | maxFixRounds is only allowed on coding tasks                                                                                                     |
| Triggers are ones the task type accepts                                                                    | `triggers`               | review tasks can't be started by chat.request; they accept pr.updated, pr.mention, review.rerun.                                                 |
| A review task sets no model or token budget                                                                | `model`, `tokenBudget`   | Review tasks can't set a model; the repo's review depth sets it.                                                                                 |
| The template parses                                                                                        | `promptTemplate`         | Line 1, column 7: Section `pr.title` is never closed.                                                                                            |
| Every variable exists for the task type                                                                    | `promptTemplate`         | `{{pr.titel}}` isn't a variable query tasks can use.                                                                                             |
| Every variable is available for every trigger                                                              | `promptTemplate`         | `{{diff}}` isn't available for chat.request. / `{{dismissal.note}}` isn't available for finding.mention.                                         |
| A coding task accepting a request trigger only uses `epic.prd` and `story.*` inside an optional section    | `promptTemplate`         | A request (chat.request) may have no epic or story: put `{{epic.prd}}` in an optional section (e.g. `{{#epic.prd}}…{{/epic.prd}}`).              |
| A variable limit names a variable the task can use                                                         | `variableLimits.<name>`  | This task can't use hunk.                                                                                                                        |
| The agent exists in the organization                                                                       | `agentId`                | There is no agent 0b7c….                                                                                                                         |
| The agent's harness tools are allowed for the task type                                                    | `agentId`                | review runs can't use the harness tool ship.                                                                                                     |
| The output schema is an object schema the harness can check output against                                 | `outputSchema`           | The output must be an object: set "type": "object".                                                                                              |
| The sink is implemented by this control panel                                                              | `sink`                   | The triage sink isn't available.                                                                                                                 |
| The sink takes the task type's output                                                                      | `sink`                   | The review sink applies the output of review tasks, not query tasks.                                                                             |
| A Markdown-answer sink gets no output schema                                                               | `sink`                   | The chat-thread sink takes a Markdown answer: remove the output schema.                                                                          |
| A structured sink gets an output schema that guarantees its shape                                          | `sink`                   | The learned-rule sink takes structured output: declare an output schema it accepts. / The learned-rule sink doesn't accept this output schema: … |
| The PR description task exists and is a query task started by `run.invoked` that outputs `{ title, body }` | `prDescriptionTaskId`    | builtin:correlate-findings isn't a query task started by run.invoked. / … has no output schema: a PR description task outputs { title, body }.   |

The form also checks the output schema is JSON (an object) before it submits. Editing an agent is
refused when tasks running on it would no longer validate: adding a harness tool one's type doesn't
allow (`tools.harness`: "Not allowed for Nightly audit (review).").

Every built-in passes the same validation (a test in `apps/web/src/lib/definitions/validation.test.ts`
runs it over all of them and their clones), so a cloned built-in saves unchanged.

## Derived requirements

What a playbook's runs need from a harness is derived from it (`playbookRequirements`; for a custom
one, also stored with its task row on save and shown under **Requirements** on the task's page):

- **Minimum harness version**: the highest of the release that runs the role's task type (query
  0.9.0, review 0.10.0, coding 0.11.0), 0.10.0 when it has setup or teardown commands, and any
  later release a variable its template uses needs.
- **Installables** and **host tools**: the playbook's `requires` (`requires.installables`, npm
  package names, and `requires.hostTools`, names from the host tool catalog), plus every
  installable whose MCP servers its tools list as `<package>:<server>` (e.g.
  `@omniralph/code-graph:graph`).

Every job of the playbook carries the minimum version (`jobs.min_harness_version`), so only
harnesses on that release or later claim it; older ones leave it queued. Built-ins carry no stored
requirements; their jobs set the version their task type needs. Jobs also carry the installables
and host tools (`jobs.required_installables`, `jobs.required_host_tools`), derived from the
playbook as it is when the job is enqueued: only a harness whose heartbeat reports every
installable and that has an effective path for every host tool claims it.

On the harness, a setup or teardown command whose first word is one of the playbook's host tools runs
that tool's negotiated absolute path, and one whose first word names a command of a required
installable runs that command's `bin` inside the installed package, never an executable of the
same name the checkout puts on the run's `PATH`. Other commands run as written. The installable
MCP servers the playbook lists are attached to its sessions from the installed packages (their tools
are `mcp__<package>_<server>__<tool>`, with every character but letters, digits, `_` and `-`
replaced by `_` and no leading `_`, e.g. `mcp__omniralph_code-graph_graph__<tool>`). The skills
of every required installable are loaded into the run's sessions as a harness-written plugin
(`<package>` lowercased with other characters as `-`, e.g. `omniralph-code-graph:<skill>`); an
installed installable the run doesn't require adds none. A run whose
host tool or installable is missing on the harness that claimed it is retried after a minute.

Each installable gets cache directories on the harness, passed to its commands (as setup or
teardown commands) and MCP servers: `OMNIRALPH_CACHE_DIR`, the run's repository cache
(`<dataDir>/cache/<package>/<repository id>/`), and on a PR trigger (`pr.updated`, `pr.mention`,
`review.rerun`, `finding.mention`, `pr.review-findings`, `pr.ci-failed`, `pr.fix-command`)
`OMNIRALPH_PR_CACHE_DIR`, the PR's cache (`<dataDir>/pr-cache/<package>/<repository id>/<number>/`).
The PR caches are a separate tree, never inside a repository cache, so data derived from an
untrusted PR must only go to the PR cache, which other runs never read. The installable owns
what's inside (including keying by commit, e.g. an index per base commit). Caches are
best-effort: nothing is stored in the control panel, and a run on another harness starts cold.
A run without a repository gets neither variable. Writing, installing and locking down
installables and host tools is covered in [installables.md](installables.md).

## Delete refusals

**Delete** (custom definitions only, after a confirmation) is refused, with nothing deleted, when:

- the definition is a built-in: "Built-in tasks can't be changed; clone one to make your own."
  (agents likewise);
- an **agent** is still used by tasks of the organization, even ones that no longer validate:
  "Security reviewer can't be deleted while tasks use it: Security review.";
- a **task** is still used (`findTaskReferrers` in `apps/web/src/lib/definitions/referrers.ts`); the
  error names each user: "Security review can't be deleted while it's used by repository acme/app
  (review task), the chat ask about code task, chat channel Acme Slack › C0123ABCD (start work),
  coding task Ship it (PR description)." Repository roles are review task, correlation task, story
  task and request task;
- a **task** has a run queued or running: "Security review can't be deleted while a run of it is
  queued or running."

Change or remove the settings named, wait for the runs, then delete. The same users keep a task's
**Task type** from changing on **Save**.

## Where custom playbooks can be chosen

Every picker lists the built-in and the organization's tasks that fit (built-ins marked), and the
server checks the pick again on save (another organization's task, or one that doesn't fit, is
refused under the field):

| Setting                                                                      | Lists                                                                                                                |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Repository › **Settings** › **Review tasks** (`/repositories/<id>/settings`) | Review tasks accepting `pr.updated`; check one or more, they run in parallel in each review run                      |
| Repository › **Settings** › **Review tasks** › **Correlation task**          | Query tasks accepting `run.invoked` whose output schema fits the correlation output (`{ findings, summary }`)        |
| Repository › **Settings** › **Coding** › **Story task**                      | Coding tasks accepting `linear.delegated`                                                                            |
| Repository › **Settings** › **Coding** › **Request task**                    | Coding tasks accepting every request trigger                                                                         |
| **Settings › Integrations** › **Chat tasks** › **Ask about code**            | Query tasks accepting `chat.request` (organization default and channel overrides; see [chat.md](chat.md#chat-tasks)) |
| **Settings › Integrations** › **Chat tasks** › **Start work**                | Coding tasks accepting `chat.request`                                                                                |
| A coding task's **Coding** › **PR description task**                         | Query tasks accepting `run.invoked` whose output schema guarantees `{ title, body }`                                 |

A task's page lists what uses it (**Used by**). Changes apply to the next run; runs already
started keep the playbook they were claimed with.

## Walkthrough: a second review playbook

Add a security reviewer next to the default review, with its own rubric:

1. **Clone the persona.** Open **Settings › Agents**, pick **Review a pull request**
   (`builtin:review-pr`, the reviewer persona) and **Clone**. On the copy's edit page, name it
   `Security reviewer` and edit its **Reference docs**: `rubric/universal.md` is the rubric every
   review gets (with `rubric/languages/<language>.md` per language in the diff). Rewrite it around
   what this reviewer looks for (e.g. injection, authz, secrets) and remove the language docs you
   don't want. **Save agent**.
2. **Clone the task.** Open **Settings › Tasks**, pick **Review a pull request**
   (`builtin:review-pr`) and **Clone**. On the copy's edit page, name it `Security review`, set
   **Agent** to `Security reviewer`, and adjust the **Template** if you like (it is checked against
   the review variables for `pr.updated`, `pr.mention` and `review.rerun`). Keep the sink `review`,
   so it reads as a `review` playbook. **Save task**.
3. **Enable it on a repository.** Open the repository's **Settings**, check `Security review`
   under **Review tasks** next to **Review a pull request**, and **Save settings**.

The next push or `@omniralph review` on a PR/MR of that repository starts one review run with both
playbooks in parallel; the correlation playbook merges findings both reported, and the posted
review's inline comments name the playbook(s) that found each issue. Nothing is deployed and no
harness changes, as long as it's on a release the playbook's [requirements](#derived-requirements)
ask for.
