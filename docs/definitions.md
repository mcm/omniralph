# Agent and task definitions

Every run a harness does (a review, a code question, a story, a PR description…) is a **task
definition** run on an **agent definition**. Omniralph ships built-in ones; organization admins can
add their own under **Settings › Agents** (`/settings/agents`) and **Settings › Tasks**
(`/settings/tasks`), with no deploy. This page explains what goes into a definition, what a save
checks (and what each error means), and where custom tasks can be picked. The design is
[ADR 0008](adr/0008-agents-tasks-and-the-harness.md#organization-definitions).

## Agents and tasks

- An **agent** says _how_ to work: a persona with a system prompt, tools, skills, reference docs, a
  model, and the task types it suits. One agent can serve many tasks.
- A **task** says _what_ to do and _when_: one task type, one agent, the triggers that start it, a
  prompt template, tool settings, where its output goes (the sink), its pool, budget and limits.

The **task type** decides how the harness runs a task. It's fixed in code; a definition only picks
one:

| Task type | What a run is                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------- |
| `query`   | One read-only session; its answer (Markdown, or JSON matching an output schema) goes to a sink.     |
| `review`  | One reviewer of a PR/MR's review run: it reports findings, merged and posted with the other tasks'. |
| `coding`  | A session that changes code in a worktree and ships it (stories and requests, ralph's coding path). |

## Built-in and custom definitions

|               | Built-in                                                       | Custom                                          |
| ------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| ID            | `builtin:<name>`, e.g. `builtin:review-pr`, `builtin:reviewer` | A UUID                                          |
| Defined in    | Code (`packages/tasks`), the same for every organization       | The organization's database rows                |
| Changing it   | A code change and a deploy                                     | **Edit** in the control panel                   |
| Who sees it   | Every organization                                             | Only its organization                           |
| Shown as      | A **Built-in** badge, "(built-in)" in pickers                  | Its name                                        |
| Edit / Delete | Never                                                          | Admins, within the [refusals](#delete-refusals) |

Members can list and view every definition (`/settings/agents/<id>`, `/settings/tasks/<id>`);
only admins create, edit, clone and delete. Built-ins can't be edited: **Clone** one to change it.
A custom task may run on a built-in agent (and then follows that agent as Omniralph changes it),
and a custom coding task may name a built-in PR description task.

### Clone

**Clone** on any definition's page (built-in or custom) copies it into a new custom definition with
a new UUID, named `<name> (copy)`, and opens its edit page:

- A cloned **agent** is an exact copy.
- A cloned **task** keeps the source's agent (clone the agent too, then pick the copy, to change
  the persona). The copy is validated like a save, and its [requirements](#derived-requirements)
  are derived again; a custom task that no longer validates (e.g. its agent was changed since)
  can't be cloned until it's fixed: "Nightly audit can't be cloned until it's fixed: …".

## The agent form

**New agent** on `/settings/agents` or **Edit** on a custom agent's page opens the form:

| Field                             | What it does                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**                          | Required, up to 200 characters.                                                                                                                                                                                                    |
| **Description**                   | Up to 2000 characters, shown in lists.                                                                                                                                                                                             |
| **Suited task types**             | At least one of `query`, `review`, `coding`. Only tasks of these types can pick the agent.                                                                                                                                         |
| **Model**                         | A Claude model ID. Empty uses the repository profile's model (or the Claude Code default). A task's **Model override** wins over it.                                                                                               |
| **Fallback model**                | Used when the model is overloaded. Empty for none.                                                                                                                                                                                 |
| **System prompt** › **Mode**      | **Append** adds the system prompt to Claude Code's preset; **Replace** uses it instead of the preset.                                                                                                                              |
| **System prompt**                 | The persona's instructions.                                                                                                                                                                                                        |
| **Tools** › **Claude Code tools** | Comma-separated Claude Code tool names (`Read, Grep, Glob`). A task's type and tool settings narrow them further (e.g. `Bash` only with **Shell**).                                                                                |
| **Tools** › **Harness tools**     | Tools of the harness's `omniralph` MCP server: `post_activity`, `ask_permission`, `get_attachment` (any type) and `ship` (coding only).                                                                                            |
| **Tools** › **Linear tools**      | Read-only Linear tools (`linear_get_issue`, `linear_list_comments`, `linear_search_issues`, `linear_get_document`); a task must also enable **Linear read access**.                                                                |
| **Tools** › **MCP servers**       | Comma-separated names of configured MCP servers, or of an installable's MCP servers as `<package>:<server>` (its tasks then require that installable).                                                                            |
| **Skills**                        | Named Markdown instructions the agent loads when a task calls for them (**Add skill**: name and content).                                                                                                                          |
| **Reference docs**                | Named Markdown documents the agent can read during a run. Review tasks render `rubric/universal.md` and `rubric/languages/<language>.md` (for the diff's languages) as `{{rubric}}`, so a reviewer's rubric is its reference docs. |

## The task form

**New task** on `/settings/tasks` or **Edit** on a custom task's page opens the form. Cards appear
for the chosen task type only (**Output schema** for query tasks, **Coding** for coding tasks).

| Field                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**, **Description**            | As for agents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Task type**                        | `query`, `review` or `coding`. It can't change while something [uses the task](#delete-refusals).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Agent**                            | Built-in and custom agents suited to the task type.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Triggers**                         | The events that may start the task, among those its type accepts (below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Prompt template** › **Template**   | The user prompt, rendered for each run ([templates](#templates)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Setup commands**                   | Commands run in order in the working directory before the session: **Name** (lowercase letters, digits and `_`, unique), **Command** (`sh -c`), **Timeout (seconds)** (default 300, at most 1800), **Output cap (bytes)** (default 20,000, at most 200,000), **Fence** (the info string around the output, e.g. `json`) and **Optional**. Each one's stdout is the variable `{{setup.<name>}}`. A failing command fails the run, unless it's optional: then its variable holds a one-line failure note. Commands run without either job token in their environment. At most 20 setup and 20 teardown commands. |
| **Teardown commands**                | Run in order after the session, whatever happened: name, command, timeout and output cap. Their output is logged; a failure never fails the run.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Tool settings**                    | Narrow the agent's tools: **Shell (Bash)** (query tasks only), **Linear read access** (the agent's Linear tools), **Network access beyond the control panel**.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Requirements**                     | Comma-separated **Installables** (npm package names) and **Host tools** (names from **Settings › Harnesses › Host tools**) the task's runs need: only harnesses that have them all claim its runs ([derived requirements](#derived-requirements)).                                                                                                                                                                                                                                                                                                                                                             |
| **Output schema** (query)            | A JSON schema of an object the run's output must match; empty for a Markdown answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Coding** › **Push**                | **After each story** or **Once at the end**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Coding** › **Draft PR**            | **The repository's setting** (`openPullRequestEarly`), **Early (after the first story)** or **At the end**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Coding** › **PR description task** | The query task that writes the PR title and description (default `builtin:describe-pr`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Coding** › limits                  | **Attempts per story** (default 3), **Story attempts per run** (50), **Review fix rounds** and **CI fix rounds** (20 each, capping the repository's settings). Empty uses the default.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Running** › **Sink**               | What applies the run's output ([sinks](#sinks)); only sinks of the task type are listed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Running** › **Pool**               | Whose concurrency slots its runs take: `short` (query and review) or `long` (coding).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Running** › **Model override**     | A Claude model ID that wins over the agent's model; empty uses the agent's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Running** › **Token budget**       | **Profile budget** (the repository profile's), a fixed number of **Tokens**, or a **% of the profile budget**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

A custom task also keeps fields the form doesn't show when it was cloned from a built-in with them
(`systemAppend`: task text appended to the agent's system prompt; `variableLimits`; `maxTurns`;
`idleTimeoutMs`).

The triggers each task type accepts:

| Task type | Triggers                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`   | `finding.mention`, `finding.dismissed`, `chat.request`, `linear.triage`, `run.invoked` (another run invokes it, e.g. correlation or a PR description) |
| `review`  | `pr.updated`, `pr.mention`, `review.rerun`                                                                                                            |
| `coding`  | `linear.delegated` (a story), and the request triggers `linear.mention`, `chat.request`, `pr.review-findings`, `pr.ci-failed`, `pr.fix-command`       |

### Sinks

| Sink             | Task type | Output                                                                     |
| ---------------- | --------- | -------------------------------------------------------------------------- |
| `chat-thread`    | query     | A Markdown answer (no output schema), posted to the chat thread            |
| `finding-thread` | query     | A Markdown answer (no output schema), posted as a reply on the finding     |
| `learned-rule`   | query     | Structured: `{ rule: string \| null }`                                     |
| `triage`         | query     | Structured: the triage result                                              |
| `run-result`     | query     | Any output, handed back to the run that invoked the task                   |
| `review`         | review    | Findings, saved and posted with the review run                             |
| `sticky-comment` | review    | A summary in one comment per PR/MR, edited in place (findings are dropped) |
| `ralph-run`      | coding    | The coding run's result                                                    |

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
- **setup**: `setup.<name>`, the output of the task's setup command `<name>`.

A task can use a variable only when its task type provides it, or **every one** of its triggers
does: a template is checked once per trigger. The full catalog, with what each variable holds, is
`VARIABLES` in `packages/tasks/src/variables.ts`; the built-in tasks' templates (`packages/tasks/src/builtin/`)
are worked examples.

### Trust and fencing

Each variable is **trusted** (IDs, numbers, names Omniralph controls) or **untrusted** (anything a
person or a model outside the run wrote: PR bodies, diffs, findings, chat messages, Linear text,
setup command output). The renderer fences every untrusted value itself, in a code fence longer
than any backtick run inside it (with the variable's info string, e.g. `diff` or `markdown`, or
the setup command's **Fence**), or between `<tag>` lines for Linear text. A template can't forget
to fence user input and can't opt out, so write `{{pr.body}}` on its own line rather than inside
your own fence. A task's `variableLimits` cut over-long values (marked `[… truncated]`) before
fencing.

## Save-time validation

**Save** (and **Create**, and **Clone** of a task) validates the definition with
`validateAgentDefinition` / `validateTaskDefinition` from `packages/tasks/src/validate.ts`, against
the organization's agents and tasks and the control panel's sinks. The forms call the server actions
`createAgentDefinition`, `updateAgentDefinition`, `cloneAgentDefinition` (and the same for tasks:
`createTaskDefinition`, `updateTaskDefinition`, `cloneTaskDefinition`), and **Delete** calls
`deleteAgentDefinition` / `deleteTaskDefinition`. A rejected save says "Fix the
highlighted fields." and shows each error under its field; nothing is stored. The rules, with the
field each error appears on and an example message:

| Rule                                                                                                       | Field                    | Example error                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| The schema: required fields, lengths, ranges, known values                                                 | The field                | `name`: Too small: expected string to have >=1 characters / `setupCommands.0.name`: Use lowercase letters, digits and \_, starting with a letter |
| Setup command names are unique                                                                             | `setupCommands.<i>.name` | Setup command name semgrep is used twice                                                                                                         |
| Only query tasks have an output schema                                                                     | `outputSchema`           | outputSchema is only allowed on query tasks                                                                                                      |
| Only coding tasks have coding fields                                                                       | The field                | maxFixRounds is only allowed on coding tasks                                                                                                     |
| Triggers are ones the task type accepts                                                                    | `triggers`               | review tasks can't be started by chat.request; they accept pr.updated, pr.mention, review.rerun.                                                 |
| The template parses                                                                                        | `promptTemplate`         | Line 1, column 7: Section `pr.title` is never closed.                                                                                            |
| Every variable exists for the task type                                                                    | `promptTemplate`         | `{{pr.titel}}` isn't a variable query tasks can use.                                                                                             |
| Every variable is available for every trigger                                                              | `promptTemplate`         | `{{diff}}` isn't available for chat.request. / `{{dismissal.note}}` isn't available for finding.mention.                                         |
| A coding task accepting a request trigger only uses `epic.prd` and `story.*` inside an optional section    | `promptTemplate`         | A request (chat.request) may have no epic or story: put `{{epic.prd}}` in an optional section (e.g. `{{#epic.prd}}…{{/epic.prd}}`).              |
| A variable limit names a variable the task can use                                                         | `variableLimits.<name>`  | This task can't use hunk.                                                                                                                        |
| The agent exists in the organization                                                                       | `agentId`                | There is no agent 0b7c….                                                                                                                         |
| The agent suits the task type                                                                              | `agentId`                | Agent builtin:reviewer suits query, review tasks, not coding.                                                                                    |
| The agent's harness tools are allowed for the task type                                                    | `agentId`                | review tasks can't use the harness tool ship.                                                                                                    |
| The output schema is an object schema the harness can check output against                                 | `outputSchema`           | The output must be an object: set "type": "object".                                                                                              |
| The sink is implemented by this control panel                                                              | `sink`                   | The triage sink isn't available.                                                                                                                 |
| The sink takes the task type's output                                                                      | `sink`                   | The review sink applies the output of review tasks, not query tasks.                                                                             |
| A Markdown-answer sink gets no output schema                                                               | `sink`                   | The chat-thread sink takes a Markdown answer: remove the output schema.                                                                          |
| A structured sink gets an output schema that guarantees its shape                                          | `sink`                   | The learned-rule sink takes structured output: declare an output schema it accepts. / The learned-rule sink doesn't accept this output schema: … |
| Pushing once at the end doesn't combine with an early draft PR                                             | `draftPullRequest`       | An early draft PR needs the stories pushed as they're done: push after each story, or open the draft PR at the end.                              |
| The PR description task exists and is a query task started by `run.invoked` that outputs `{ title, body }` | `prDescriptionTaskId`    | builtin:correlate-findings isn't a query task started by run.invoked. / … has no output schema: a PR description task outputs { title, body }.   |

The form also checks the output schema is JSON (an object) before it submits. Editing an agent is
refused when tasks running on it would no longer validate: dropping a task type one of them has
(`taskTypes`: "Still used by Nightly audit (review).") or adding a harness tool one's type doesn't
allow (`tools.harness`).

Every built-in passes the same validation (a test in `apps/web/src/lib/definitions/validation.test.ts`
runs it over all of them and their clones), so a cloned built-in saves unchanged.

## Derived requirements

A task save also derives what its runs need from a harness and stores it with the row (shown under
**Requirements** on the task's page):

- **Minimum harness version**: the highest of the release that runs the task type (query 0.9.0,
  review 0.10.0, coding 0.11.0), 0.10.0 when it has setup or teardown commands, and any later
  release a variable its template uses needs.
- **Installables** and **host tools**: the task's **Requirements** (`requires.installables`,
  npm package names, and `requires.hostTools`, names from the host tool catalog), plus every
  installable whose MCP servers the agent lists as `<package>:<server>` (e.g.
  `@omniralph/code-graph:graph`).

Every job of the task carries the minimum version (`jobs.min_harness_version`), so only harnesses
on that release or later claim it; older ones leave it queued. Built-ins carry no stored
requirements; their jobs set the version their task type needs. Jobs also carry the installables
and host tools (`jobs.required_installables`, `jobs.required_host_tools`), derived from the task
and its agent as they are when the job is enqueued: only a harness whose heartbeat reports every
installable and that has an effective path for every host tool claims it.

On the harness, a setup or teardown command whose first word is one of the task's host tools runs
that tool's negotiated absolute path, and one whose first word names a command of a required
installable runs that command's `bin` inside the installed package, never an executable of the
same name the checkout puts on the run's `PATH`. Other commands run as written. The installable
MCP servers the agent lists are attached to its sessions from the installed packages (their tools
are `mcp__<package>_<server>__<tool>`, with every character but letters, digits, `_` and `-`
replaced by `_` and no leading `_`, e.g. `mcp__omniralph_code-graph_graph__<tool>`). A run whose
host tool or installable is missing on the harness that claimed it is retried after a minute.

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

## Where custom tasks can be chosen

Every picker lists the built-in and the organization's tasks that fit (built-ins marked), and the
server checks the pick again on save (another organization's task, or one that doesn't fit, is
refused under the field):

| Setting                                                                      | Lists                                                                                                                |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Repository › **Settings** › **Review tasks** (`/repositories/<id>/settings`) | Review tasks accepting `pr.updated`; check one or more, they run in parallel in each review run                      |
| Repository › **Settings** › **Review tasks** › **Correlation task**          | Query tasks accepting `run.invoked` whose output schema fits the correlation output (`{ findings, summary }`)        |
| Repository › **Settings** › **Ralph** › **Story task**                       | Coding tasks accepting `linear.delegated` (used on the coding-tasks **Coding path**)                                 |
| Repository › **Settings** › **Ralph** › **Request task**                     | Coding tasks accepting every request trigger                                                                         |
| **Settings › Integrations** › **Chat tasks** › **Ask about code**            | Query tasks accepting `chat.request` (organization default and channel overrides; see [chat.md](chat.md#chat-tasks)) |
| **Settings › Integrations** › **Chat tasks** › **Start work**                | Coding tasks accepting `chat.request`                                                                                |
| A coding task's **Coding** › **PR description task**                         | Query tasks accepting `run.invoked` whose output schema guarantees `{ title, body }`                                 |

A task's page lists what uses it (**Used by**). Changes apply to the next run; runs already
started keep the definition they were claimed with.

## Walkthrough: a second review task

Add a security reviewer next to the default review, with its own rubric:

1. **Clone the agent.** Open **Settings › Agents**, pick **Reviewer** (`builtin:reviewer`) and
   **Clone**. On the copy's edit page, name it `Security reviewer` and edit its **Reference docs**:
   `rubric/universal.md` is the rubric every review gets (with `rubric/languages/<language>.md` per
   language in the diff). Rewrite it around what this reviewer looks for (e.g. injection, authz,
   secrets) and remove the language docs you don't want. **Save agent**.
2. **Clone the task.** Open **Settings › Tasks**, pick **Review a pull request** (`builtin:review-pr`) and
   **Clone**. On the copy's edit page, name it `Security review`, set **Agent** to
   `Security reviewer`, and adjust the **Template** if you like (it is checked against the review
   variables for `pr.updated`, `pr.mention` and `review.rerun`). Keep the sink `review`. **Save
   task**.
3. **Enable it on a repository.** Open the repository's **Settings**, check `Security review`
   under **Review tasks** next to **Review a pull request**, and **Save settings**.

The next push or `@omniralph review` on a PR/MR of that repository starts one review run with both
tasks in parallel; the correlation task merges findings both reported, and the posted review's
inline comments name the task(s) that found each issue. Nothing is deployed and no harness changes,
as long as it's on a release the task's [requirements](#derived-requirements) ask for.
