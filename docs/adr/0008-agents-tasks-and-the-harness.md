# ADR 0008: Agents, tasks and the harness

- **Status:** Accepted (TOOL-302, the first of six epics). Supersedes the capability parts of
  [ADR 0006](0006-postgres-job-queue.md) and the job-token scopes of
  [ADR 0003](0003-ralph-orchestration.md).
- **Date:** 2026-10-11

## Context

Omniralph had 11 hard-coded job types. Each bundled harness orchestration code, Claude Agent SDK
parameters (system prompt, tools, model, budget), its payload and result shapes, and the
credentials it needed. Three capabilities, `review`, `ralph` and `triage`, decided at once:

- **persona:** which prompts and tools a job's session got;
- **privilege:** whether a host may run it at all (the capabilities enabled for it in the control panel), and what its job token
  may do (scopes chosen per capability, e.g. only `ralph` could push);
- **concurrency:** how many of a host's slots it may take (a concurrency cap per capability).

So a new kind of question for Claude, or a changed prompt, meant new code in the host package and a
release to every host, and a capability couldn't be made more trusted without also changing its
concurrency or its persona. The word "agent" also meant two things: the host daemon
(the npm package now named `@omniralph/harness`) and, increasingly, the AI persona it runs.

## Decision

**Jobs run _task definitions_ on _agent definitions_ through three fixed _task types_. The control
panel resolves everything a run needs into a _run spec_ when a harness claims the job, and applies
the run's output through a _sink_. Persona (agent), privilege (task type, harness trust, token
kind) and concurrency (pool) are separate levers.**

### Vocabulary

| Term                 | Meaning                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Harness**          | A host running `omniralph-harness` (package `@omniralph/harness`, config `~/.config/omniralph/harness.json`). Formerly "agent": tables `harnesses`, `harness_enrollments`, `harness_refresh_tokens`, `harness_audit`, `harness_repo_pins`, API `/api/harness/*`, JWT audience `omniralph-harness`, pages **Harnesses** and **Settings › Harnesses**. |
| **Agent definition** | A reusable persona: system prompt (`append` to or `replace` the Claude Code preset), tools (built-in, harness, Linear, MCP servers), skills, reference docs, model, and the task types it suits.                                                                                                                                                     |
| **Task definition**  | One task on one agent: task type, triggers, prompt template, optional `systemAppend`, tool settings (`shell`, `linearRead`, `network`), output schema, sink, pool, model, token budget, per-variable limits, idle timeout and turn cap.                                                                                                              |
| **Task type**        | How the harness runs a task: `query`, `review` or `coding`. A fixed lifecycle per type, in harness code.                                                                                                                                                                                                                                             |
| **Run spec**         | Everything one run needs, resolved by the control panel at claim time and sent with the job.                                                                                                                                                                                                                                                         |
| **Sink**             | Control-panel code, keyed by kind, that validates and applies a run's output.                                                                                                                                                                                                                                                                        |
| **System RPC**       | A fixed harness command with no Claude session (`repo.sync`), carried by the same claim and lease plumbing.                                                                                                                                                                                                                                          |
| **Pool**             | A named concurrency pool. A job takes a slot of its pool; harnesses limit their jobs per pool.                                                                                                                                                                                                                                                       |

"Agent" now only means an agent definition. A few internal names keep the old word on purpose: the
harness config key `agentId`, the env vars `KMS_AGENT_ISSUER_ID` and `LOCAL_AGENT_SIGNING_KEY`,
wire error codes (`unknown_agent`, `agent_revoked`, `no_capable_agent`, `not_current_agent`), the
chat assistant's `apps/web/src/lib/chat/agent/`, and the filenames
`.github/workflows/publish-agent.yml` (npm trusted publishing is registered against it),
`scripts/smoke-agent-package.sh` and [ADR 0002](0002-agent-auth.md).

### Definitions (`@omniralph/tasks`)

`packages/tasks` is shared by the control panel and the harness. It holds the zod schemas
`AgentDefinition` and `TaskDefinition` (`definitions.ts`), the fixed vocabularies (`kinds.ts`:
task types, pools, trigger kinds, sink kinds, harness and Linear tools), the variable catalog
(`variables.ts`), the template engine (`template.ts`) and the built-in definitions
(`builtins.ts`, `builtin/*.ts`).

- **IDs.** Built-ins are `builtin:<name>`; user-defined definitions (a later epic) are UUIDs.
- **Validation.** `validateAgentForTask` rejects an agent that doesn't list the task's type, or
  wants harness tools the type doesn't allow. `builtinProblems` checks every built-in (templates,
  variables, limits, agent fit); a test keeps it empty.
- **Built-ins of this epic** (all `query` tasks in the `short` pool):

  | Task                       | Agent                                                       | Trigger             | Sink             | Notes                                                             |
  | -------------------------- | ----------------------------------------------------------- | ------------------- | ---------------- | ----------------------------------------------------------------- |
  | `builtin:learn-rule`       | `builtin:rule-writer` (no tools)                            | `finding.dismissed` | `learned-rule`   | 5000 tokens; output `{ rule: string \| null }`                    |
  | `builtin:reply-to-finding` | `builtin:reviewer` (Read, Grep, Glob)                       | `finding.mention`   | `finding-thread` | 10 % of the profile budget, 10 turns                              |
  | `builtin:ask-about-code`   | `builtin:code-explainer` (Read, Grep, Glob)                 | `chat.request`      | `chat-thread`    | 25 % of the profile budget, 30 turns                              |
  | `builtin:triage`           | `builtin:planner` (Read, Grep, Glob, the four Linear tools) | `linear.triage`     | `triage`         | `opus`, no budget, 5 min idle timeout, output = the triage schema |

  They replace the job types `review.learn-rule`, `review.reply`, `chat.ask` and `triage.run`,
  whose names stay as job types and dedupe-key prefixes. Their prompts render byte for byte as the
  old prompt builders did: snapshot tests in `packages/tasks` and equality tests in
  `packages/engine` (and against `@omniralph/ralph`'s `buildTriagePrompt`) prove it.

### Templates

Prompt templates are a logic-less subset of Mustache: variables (dotted names, `{{.}}`), sections
and inverted sections, and comments. Partials, lambdas, delimiter changes, triple mustache and
`{{& x}}` are parse errors, and nothing is HTML-escaped. `validateTemplate` checks every variable
against the variables available to the task (`taskVariables(task)`: `availableVariables(taskType,
triggers)` plus its `setup.<name>` variables).

Every catalog variable has a source (`trigger`, `taskType` or `setup`) and a trust level.
`renderTemplate` fences **untrusted** values itself, in a code fence longer than any backtick run
inside (the engine's `fence()` convention), or between `<tag>` lines for entries with a `quote`
tag. A template can't forget to fence user input and can't opt out. A task's `variableLimits` cut
over-long values (with `[… truncated]`) before fencing.

### Task types and the query lifecycle

| Task type | What the harness does                            | Pool    | Status                                                     |
| --------- | ------------------------------------------------ | ------- | ---------------------------------------------------------- |
| `query`   | One read-only session; its output goes to a sink | `short` | Built here                                                 |
| `review`  | A review run                                     | `short` | `review.run` still runs through its legacy capability code |
| `coding`  | A session that changes code and ships it         | `long`  | `ralph.*` still run through their legacy capability code   |
| `system`  | A system RPC, no session                         | none    | `repo.sync`                                                |

`runQueryTask` (`apps/harness/src/lifecycle/query.ts`) runs every query task with no per-task
code:

1. **Prepare.** Without a `ref`, an empty temp directory. With one, the repository is synced and a
   disposable worktree of the ref checked out. A ref that can't be fetched leaves an empty
   directory without file tools, or, with `requireCheckout`, finishes with `no_checkout` and no
   session. The task's setup commands then run there (see below).
2. **Render** the task's template over the trigger context plus the query variables (`question`,
   `hunk`, `conventions`, `checkout`) and the `setup` variables.
3. **One session**: the agent's system prompt plus the task's `systemAppend`; the agent's tools
   narrowed by the task's tool settings and the repository's tool settings (they only ever
   narrow); the run's model, token budget and turn cap; the `session` token in its environment.
4. **Finish.** A structured result is validated against the task's output schema; otherwise the
   answer is the final Markdown text plus the checkout's files it cites. A rate limit is a
   retryable failure.
5. **Teardown.** The task's teardown commands run, then the worktree or temp directory is removed,
   whatever happened.

### Setup and teardown commands

Any task definition can declare `setupCommands` (each with a `name`, `command`, `timeoutMs`,
`maxOutputChars`, a `fence` info string and `optional`) and `teardownCommands` (`command`,
`timeoutMs`). This is how deterministic tools (Semgrep, a code graph) feed a session without
harness code. Commands run with `bash -lc` in the working directory, in their own process group
(killed whole on timeout), with the harness's environment minus every `OMNIRALPH_*` variable, so
neither job token. Each setup command's stdout, cut to `maxOutputChars` and marked when cut,
becomes the untrusted variable `setup.<name>` (`taskVariables`/`taskCatalog` in
`@omniralph/tasks` add them to the template's available variables and the render catalog). A
failing setup command (non-zero exit, timeout) fails the run, unless it's `optional`: then its
variable holds a short failure note. Teardown commands always run after finish, even when setup or
the session failed; their failures are logged only. Runs of tasks with any commands carry
`SETUP_COMMANDS_MIN_HARNESS_VERSION` as their `min_harness_version`.

The daemon dispatches a claimed job by its task type: `system` jobs to the system RPC registry,
jobs with a run spec to their task type's lifecycle, the rest to the legacy capabilities
(`review`, `ralph`).

### Run specs, resolved at claim time

A run-spec job is a `jobs` row with a `task_id` and a `RunSpecJobPayload`: the trigger
(`{ kind, context }`), an optional repository and `ref`, and `requireCheckout`. Enqueueing code
builds it with `runSpecJobInput(task)`. When a harness claims the job, the claim route resolves it
(`resolveRunSpec`, `apps/web/src/lib/runs/resolve.ts`) into a `RunSpec`, returned next to the job:

- the task and its agent, the agent's tools already narrowed by the repository's tool settings;
- the trigger, repository, `ref` and `requireCheckout`;
- the model (task's, else the repository profile's, else the agent's), fallback model and token
  budget (a fixed number or a fraction of the profile's budget);
- the `lifecycle` and `session` tokens.

Resolving at claim time means a definition or repository change applies to every run not yet
started, and the harness needs no database or definition store. A job whose spec can't be resolved
(e.g. an unknown task) is failed inside the claim transaction and the claim moves on.

### Pools, harness trust and claim eligibility

`jobs` gained `task_type` (`query | review | coding | system`), `pool`, `task_id` and
`min_harness_version`, and lost `capability` (migrations `0056_task_types_and_pools.sql`,
`0057_drop_capabilities.sql`). Legacy job types map with `legacyJobRouting`: `review.run` →
review/short, `ralph.*` → coding/long (`ralph.describe-pr` → query/short), `repo.sync` →
system/no pool.

- **Trust:** `harnesses.accepted_task_types` (default `query`, `review`) says which task types a
  host may run. `system` jobs are always accepted. This replaces the per-harness capability toggles.
- **Concurrency:** `short` and `long` pools are seeded per organization (`pools`).
  `harnesses.pool_limits` replaces `capability_limits`; an unset pool defaults to max concurrency
  for `short` and max concurrency − 1 (at least 1) for `long`, as ralph had. The heartbeat
  delivers both, and the harness only asks for pools it has a free slot in.
- **The claim** (`POST /api/harness/claim`, `ClaimRequest { pools, waitSeconds? }`) selects, on
  top of [ADR 0006](0006-postgres-job-queue.md)'s organization, target and status rules, jobs
  whose task type is accepted and whose pool was requested, or `system` jobs, and whose
  `min_harness_version` is null or at most the harness's reported version. The version gate
  replaces the heartbeat's `chatAskAgents`; `chat.ask` and `triage.run` jobs set it to
  `QUERY_TASKS_MIN_HARNESS_VERSION` (0.9.0), so older harnesses leave them queued.

### Lifecycle and session tokens

A run-spec job gets two job tokens (both `typ: "job"`, 900 s, renewed by the heartbeat):

| Kind        | Held by                                                                                                                                  | Scopes                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `lifecycle` | The harness, for its own git calls (syncing and checking out the repository)                                                             | `credentials:read`; `credentials:write` only for `coding` runs                                  |
| `session`   | The Claude session: `OMNIRALPH_JOB_TOKEN` / `OMNIRALPH_JOB_TOKEN_FILE` in its env, its git credential helper, the `omniralph` MCP server | `credentials:read`, `run:activity`, `run:attachments`, `linear:read`; never `credentials:write` |

The credential broker decides push access by token kind and task type: only a `coding` run's
`lifecycle` token (or, until the coding epic, a legacy `ralph.*` job's single token) gets a write
credential. Legacy jobs keep one token without a kind: `review.run` and system RPCs
`credentials:read`, `ralph.*` also `credentials:write`, `run:activity` and `run:attachments` (renamed
from their ralph-only names). [ADR 0002](0002-agent-auth.md) has the token
format and verification.

### Harness tools: the `omniralph` MCP server

Sessions reach harness primitives through an in-process MCP server named `omniralph`
(`apps/harness/src/tools/omniralph-server.ts`), which calls the control panel with the session
token:

- `post_activity`, `ask_permission`, `get_attachment`, backed by
  `/api/harness/jobs/{id}/activities`, `permissions` and `attachments`. These routes are no longer
  ralph-only: they accept any running job whose token has `run:activity` or `run:attachments`, and
  store activities and permission requests per job (`run_activities`,
  `run_permission_requests`).
- The read-only Linear tools `linear_get_issue`, `linear_list_comments`, `linear_search_issues` and
  `linear_get_document`, served by the control panel under `/api/harness/runs/{id}/linear/*`,
  scoped to the run's organization and the `linear:read` scope. A session gets them only when its
  agent lists them and the task turns on `linearRead`. Every Linear write goes through a sink.

A session is offered the agent's harness tools that its task type allows
(`HARNESS_TOOLS_BY_TASK_TYPE`). Without any, no server is attached.

### Sinks

Sinks (`apps/web/src/lib/sinks`) replace the per-type outcome handlers of
`apps/web/src/lib/jobs/handlers.ts` for ported types. Each has a kind, the output schema it accepts
(null = a Markdown answer) and hooks `onStarted`, `apply`, `onFailed` and `onCanceled`; `jobHooks`
picks a run-spec job's sink or a legacy job's handler. The claim, result and fail routes, the
expiry cron and cancellation all go through it. A result the sink doesn't accept is rejected
with 400 before the job completes.

| Kind             | Applies                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `learned-rule`   | Stores the learned rule (skips duplicates and changed feedback)                                  |
| `finding-thread` | Posts the reply in the finding's PR/MR thread                                                    |
| `chat-thread`    | Posts the code answer (with file links) in the chat thread                                       |
| `triage`         | Applies the triage output to the Linear issue (re-checks locked issues before and after the run) |

Sinks stay idempotent: results can be replayed, and comments go through `postJobCommentOnce`.
Every model output is sanitized (`sanitizeCapped`) before it's posted. The kinds `review`,
`sticky-comment` and `run-result` exist in the vocabulary for later epics but have no sink yet.

### System RPCs

`repo.sync` is a system RPC (`apps/harness/src/rpc/`, `SYSTEM_RPCS` in `@omniralph/shared`): a
fixed command with no Claude session, no run spec and no session token, targeted at one harness,
with a single `credentials:read` token. It uses the same claim, lease, result and fail plumbing as
every other job. Self-update stays on the heartbeat.

### What later epics add

This epic built the plumbing and the query task type. Not built here:

- the `review` lifecycle and the port of `review.run` (with the `review` and `sticky-comment`
  sinks);
- the `coding` lifecycle and the port of `ralph.*`, including the `ship` harness tool, the
  `run-result` sink, `describePrTaskId` and the end of legacy single tokens;
- installables and the `worktree.*` and `install` system RPCs;
- user-defined (UUID) agent and task definitions and the UI to create and edit them, and a chat
  tool to run tasks.

## Alternatives considered

- **Keep job types, make prompts configurable.** Moves prompts out of code but keeps per-type
  orchestration, payloads and outcome handlers, so a new kind of task still needs a host release,
  and capabilities still tie persona, privilege and concurrency together.
- **Resolve definitions on the harness.** The harness would need a definition store or database
  access, and changes would race with running hosts. Resolving at claim time keeps the harness
  stateless and lets the control panel narrow tools and pick models per repository.
- **A full template language (Handlebars, Liquid).** Logic in templates makes them hard to
  validate and lets a template skip fencing. Logic-less Mustache plus a catalog makes fencing the
  renderer's job.
- **One token per run.** The session runs model-controlled tools and must never push or act as
  the harness; a separate `session` token makes that a property of the token, not of the code
  path.

## Breaking points: revisit this decision when

1. **A task needs a step the lifecycles don't have** (e.g. two sessions, or a session per file).
   Add it to the task type's fixed lifecycle, or add a task type, not per-task harness code.
2. **Definitions need versioning.** Run specs resolve the current definition; if runs must be
   reproducible against the definition they were enqueued with, store a definition snapshot or
   version on the job.
3. **Pools need more than per-harness limits** (organization-wide caps, priorities), which changes
   the claim's `order by` and eligibility.
4. **Untrusted text reaches a session outside the template** (e.g. through a tool result). The
   fencing only covers rendered prompts; tool output needs its own handling.

## Consequences

- Adding or changing a query task is a change to definitions in `packages/tasks`, with no harness
  code. The harness's `capabilities/` no longer has `chat-ask.ts`, `reply.ts`, `learn-rule.ts` or
  `triage/`.
- Trust, concurrency and persona are configured separately: **Harnesses › <harness>** sets
  accepted task types and pool limits, and the task definition sets the agent and pool.
- The claim route does more work (resolving and signing two tokens per run-spec job).
- A Claude session never holds a push credential.
- The rename needed a one-time reinstall of every host (`@omniralph/harness`, the new config
  path), since hosts on 0.8.0 can't self-update across it; see
  [deploy-harness.md](../deploy-harness.md#reinstalling-a-host-after-the-rename).
