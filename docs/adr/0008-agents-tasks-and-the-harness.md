# ADR 0008: Agents, tasks and the harness

- **Status:** Accepted (TOOL-302, the first of six epics). Supersedes the capability parts of
  [ADR 0006](0006-postgres-job-queue.md) and the job-token scopes of
  [ADR 0003](0003-ralph-orchestration.md). Amended by TOOL-303 (the second epic): the `review`
  task type, review runs, setup and teardown commands and the `review`, `sticky-comment` and
  `run-result` sinks. Amended by TOOL-304 (the third epic): the `coding` task type, coding runs
  behind a per-repository switch, the `ship` harness tool, push and draft PR timing, and the
  `worktree.exec` and `worktree.cleanup` system RPCs. Amended by TOOL-306 (the fifth epic):
  [organization definitions](#organization-definitions) stored in the database and edited in the
  control panel. Amended by TOOL-307 (the sixth epic): [installables and host
  tools](#installables-and-host-tools) and the `install` system RPC.
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
| **System RPC**       | A fixed harness command with no Claude session (`repo.sync`, `worktree.exec`, `worktree.cleanup`), carried by the same claim and lease plumbing.                                                                                                                                                                                                     |
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

_Since TOOL-592 a built-in is one **playbook** (`Playbook` in `playbooks.ts`: role, prompts,
model, tools, requirements) instead of an agent and a task kept in sync. The role fixes the task
type, triggers and sink (`PLAYBOOK_ROLES`); agent task types and skills, `validateAgentForTask` and
`AgentDefinition` are gone (the run spec's agent half is `RunSpecAgent`). `playbookRunSpec` builds
the run spec's `agent` and `task` from a playbook, so the harness protocol is unchanged, and the
control panel resolves runs through a `PlaybookSource` (`organizationPlaybooks`). The built-in
agents (`builtin:reviewer`, `builtin:engineer`, …) folded into their playbooks, which keep their
tasks' IDs. See [definitions.md](../definitions.md)._

- **IDs.** Built-ins are `builtin:<name>`; an organization's own definitions are UUIDs
  ([organization definitions](#organization-definitions)).
- **Validation.** `validateAgentForTask` rejects an agent that doesn't list the task's type, or
  wants harness tools the type doesn't allow. `builtinProblems` checks every built-in (templates,
  variables, limits, agent fit); a test keeps it empty.
- **Built-ins of TOOL-302** (all `query` tasks in the `short` pool):

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

- **Built-ins of TOOL-303** (all in the `short` pool; see [Review runs](#review-runs)):

  | Task                         | Type     | Agent                                                       | Triggers                                   | Sink             | Notes                                                                                    |
  | ---------------------------- | -------- | ----------------------------------------------------------- | ------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------- |
  | `builtin:review-pr`          | `review` | `builtin:reviewer` (Read, Grep, Glob; the rubric as docs)   | `pr.updated`, `pr.mention`, `review.rerun` | `review`         | Today's review; the default review task of every repository                              |
  | `builtin:summarize-pr`       | `review` | `builtin:reviewer`                                          | `pr.updated`, `pr.mention`, `review.rerun` | `sticky-comment` | A PR/MR summary, no findings; off unless a repository picks it                           |
  | `builtin:correlate-findings` | `query`  | `builtin:correlator` (no tools, replaces the preset prompt) | `run.invoked`                              | `run-result`     | 50 % of the profile budget, no checkout; fixed output schema (merged findings + summary) |

  `builtin:review-pr` replaces the `review.run` job type. Its template renders byte for byte as
  the engine's `buildPrompt` did, and `builtin:reviewer`'s prompt plus its `systemAppend` is
  exactly `REVIEW_SYSTEM_PROMPT` (`packages/engine/src/reviewPr-builtin.test.ts` checks both,
  the prompt over 11 profile and input cases);
  the rubric moved into `builtin:reviewer`'s reference docs (`builtin/rubric.ts`, generated from
  `packages/engine/src/rubric` by `pnpm --filter @omniralph/tasks generate:rubric`). Templates
  that need a literal `{{` (e.g. GitHub Actions' `${{ }}`) write `\{{`.

- **Built-ins of TOOL-304** (see [Coding runs](#coding-runs)):

  | Task                      | Type     | Agent                                                            | Triggers                                                                                 | Sink         | Notes                                                                   |
  | ------------------------- | -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------- |
  | `builtin:implement-story` | `coding` | `builtin:engineer` (ralph's tool policy; the four harness tools) | `linear.delegated`                                                                       | `ralph-run`  | `long` pool, `opus`; one attempt at one story                           |
  | `builtin:handle-request`  | `coding` | `builtin:engineer`                                               | `linear.mention`, `chat.request`, `pr.review-findings`, `pr.ci-failed`, `pr.fix-command` | `ralph-run`  | `long` pool, `opus`; one request session on the lane's branch           |
  | `builtin:describe-pr`     | `query`  | `builtin:pr-writer` (Read, Grep, Glob)                           | `run.invoked`                                                                            | `run-result` | `short` pool, checkout of the branch required; output `{ title, body }` |

  Their templates render byte for byte as `buildStoryPrompt`, `buildRequestPrompt` and
  `buildDescribePrPrompt` did for the same inputs (snapshots and parity tests in
  `packages/tasks/src/builtin/coding.test.ts`), with two intended differences in request prompts:
  they say to call `ship` instead of `git push`, and a request on a run that isn't a Linear epic
  never mentions epics, PRDs or stories. `builtin:engineer`'s system prompt is mode-neutral; the
  story-only rules live in `builtin:implement-story`'s template.

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

| Task type | What the harness does                            | Pool    | Status                                            |
| --------- | ------------------------------------------------ | ------- | ------------------------------------------------- |
| `query`   | One read-only session; its output goes to a sink | `short` | Built in TOOL-302                                 |
| `review`  | One review session over a PR/MR's diff           | `short` | Built in TOOL-303                                 |
| `coding`  | A session that changes code and ships it         | `long`  | Built in TOOL-304, behind a per-repository switch |
| `system`  | A system RPC, no session                         | none    | `repo.sync`, `worktree.exec`, `worktree.cleanup`  |

`runQueryTask` (`apps/agent/src/lifecycle/query.ts`) runs every query task with no per-task
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

### The review lifecycle

`runReviewTask` (`apps/agent/src/lifecycle/review.ts`) runs every review task the same way, with
the review inputs (base and head SHAs, change request, review config, previous review) in the
trigger context (`ReviewTaskContext`):

1. **Prepare.** The repository is synced at the base and head (and, best effort, the previously
   reviewed head), a disposable worktree of the head checked out, and the task's setup commands
   run there. The engine's `prepareReview` then resolves the scope (full or incremental), diffs and
   parses it, plans it deterministically (`planReview`: path excludes, `riskScan`, the run's
   `maxFiles`) and reads the base branch's `CLAUDE.md`. With nothing left to review there's no
   session.
2. **Render** the template over the trigger context plus the review variables (`reviewVariables`:
   `diff`, `plan`, `risk`, `conventions`, `depth`, `rubric`, `repositoryRules`,
   `previousFindings`) and the `setup` variables. The diff, conventions and previous findings are
   untrusted and fenced.
3. **One session** (`provider.review`): the agent's system prompt plus the task's `systemAppend`
   replace the engine's review system prompt (including in its one repair turn for unparseable
   output); tools as a query session's, and the file tools only when the profile allows repository
   exploration; the `session` token only.
4. **Finish.** The output (`{ findings, summary? }`) is filtered to the diff (`filterToDiff`),
   made self-contained, deduplicated against the previous review's open findings and turned into
   fixed votes (`finishReview`), then capped (`capFindings`). A rate limit is a retryable failure.
5. **Teardown** as in the query lifecycle.

The review profile still narrows each review run at claim time (`narrowByReviewProfile` in
`resolveRunSpec`): the profile's model wins over the task's and the agent's, the token budget is
the smaller of the profile's maximum and the task's, and `maxFiles` comes from the profile. (Review
profiles have since become the three review depth presets, Quick, Standard and Deep, in
`REVIEW_DEPTHS` of `@omniralph/shared`; a review's `reviewConfig.profile` carries its depth's
preset. Since TOOL-587 the depth alone sets a review's model and token cap, in
`narrowByReviewDepth`; review tasks can't set either, and other runs' budgets are a fixed number of
tokens or none, never a fraction of the depth's: see [definitions](../definitions.md#model-and-token-budget).)
Review run specs carry `REVIEW_TASKS_MIN_HARNESS_VERSION` (0.10.0): older harnesses leave them queued.

### Coding runs

`runCodingTask` (`apps/agent/src/lifecycle/coding.ts`) runs coding tasks. The trigger context is
the legacy ralph payload the control panel built (`RalphStoryPayload`, `RalphRequestPayload` or
`RalphPushPayload`, from `apps/web/src/lib/ralph/payload.ts`), so `advanceRun`'s logic is the same
on both paths ([ADR 0003](0003-ralph-orchestration.md#addendum-coding-runs-and-the-cutover-switch)).
The lifecycle is today's ralph code, moved rather than rewritten (`story-attempt.ts`,
`request-attempt.ts`; the legacy `capabilities/ralph/story.ts` and `request.ts` are thin wrappers
around the same code):

1. **Prepare.** The lane's long-lived branch worktree (`withBranchWorktree`: created from the
   remote branch, the run's hidden ref or the base; the repository's setup command once; the
   `pre-push` guard), the stash offered from an earlier attempt, the Linear attachments and the
   progress file.
2. **Render** the task's template over the trigger context (`storyTemplateContext`,
   `requestTemplateContext` from `@omniralph/ralph`) plus the task-type variables (`progress`,
   `stashes`, `feedback`, `attempt`, …).
3. **One session** with the agent's system prompt, ralph's tool policy narrowed by the run spec's
   tools, the model (the repository's ralph model, else the run spec's), and only the `session`
   token: its env and git credential helper read the session token file. A request run resumes
   the lane's earlier Claude session on the same harness and takes live messages.
4. **Finish.** A story run runs the quality gates, commits (`feat(<ID>)`, or a wip commit when
   blocked) and pushes with the `lifecycle` token: `-u origin <branch>`, or to the run's hidden ref
   when the task pushes at the end; a rejected push resets the commit and stashes the work. A
   request run's session ships through the `ship` harness tool (below); a `/ship` request commits
   and pushes after the session instead. Leftovers are stashed. The result (`RalphStoryResult` or
   `RalphRequestResult`) goes to the `ralph-run` sink, which calls the ralph outcome hooks.

A `RalphPushPayload` run (`ralph.push`) has no session: it checks out the branch worktree from the
hidden ref and pushes the branch once.

**Settings.** A coding task carries the loop's limits (`maxAttemptsPerStory`,
`maxIterationsPerRun`, `maxReviewRounds`, `maxFixRounds`; a repository's rounds are capped by the
request task's), `prDescriptionTaskId` (default `builtin:describe-pr`, a query task taking
`run.invoked`), `pushTiming` (`per-story`, the default, or `end`) and `draftPullRequest` (`early`
or `end`; unset follows the repository's `openPullRequestEarly`). `validateCodingTask` rejects
`pushTiming: end` with `draftPullRequest: early` (the draft would have nothing to show), a
`prDescriptionTaskId` that isn't such a query task, and, on a task that accepts a request
trigger, a template that uses `epic.prd` or `story` outside an optional section. The repository's
ralph settings (verify commands, model, tools, history rewrites, review and CI rounds, cleanup)
still apply to every run.

_Since TOOL-601 `ralph_settings` is gone (migration `0098_repository_coding_policy`, which refuses to
run while a repo has a value that would be lost). A repo keeps six coding fields: `ralph_enabled`
(`coding_enabled` since TOOL-612), its work item match, `coding_instructions`,
`open_pull_request_early`, `history_rewrite` and `respond_to_reviews_and_ci`. The rest moved to the story and request playbooks' `coding` (verify
and worktree setup commands, PRD gates, preparation, epic completed state, cleanup, and the review
and CI rounds, 3 by default, no longer capped by a repo value) and to the organization's
`tracker.labels` (manual and blocked labels). See [definitions](../definitions.md#coding-settings)._

**Pushing at the end.** With `pushTiming: end` every story commit goes to the run's hidden ref
`refs/omniralph/runs/<run>` (the `pre-push` guard allows that ref and no other), so another harness
continues from it; once every story is done a `ralph.push` job pushes the branch, then the PR/MR
is described. The control panel records each hidden ref (`hidden_refs`) and deletes the run's refs
with a `worktree.cleanup` RPC when the run completes or fails; the daily `prune-hidden-refs` cron
retries missed ones and deletes refs older than 14 days of runs that aren't running.

**The PR/MR description** is a run of the story task's `prDescriptionTaskId`, invoked by the
ralph run (`RunInvoker { kind: "ralph-run" }`) on a checkout of the branch, whose fixed
`{ title, body }` output the `run-result` sink hands to the run's publish step.

Story and request runs run the task's own setup commands in the branch worktree (after the
repository's **Setup command**, which runs only when the worktree is created, and after leftover
work is stashed) just before the prompt is rendered, and pass their output as `setup.<name>`;
the teardown commands run in the worktree after the attempt, whatever happened. Whatever setup
commands leave in the worktree is part of it: the story's commit or the next attempt's stash, so
write outside it or to ignored paths. Push runs have no prompt and run neither. Coding runs
(story, request and push runs) carry `CODING_TASKS_MIN_HARNESS_VERSION` (0.11.0, the first
release with the coding lifecycle) as their `min_harness_version`, so an older harness leaves them
queued instead of failing them as an unsupported task type. A query run a ralph run invokes (its
PR description) takes the repository's ralph model and fallback model over the task's
(`resolveRunSpec`), like the legacy `ralph.describe-pr` job.

### Setup and teardown commands

Any task definition can declare `setupCommands` (each with a `name`, `command`, `timeoutSeconds`,
`maxOutputBytes`, a `fence` info string and `optional`) and `teardownCommands` (`name`, `command`,
`timeoutSeconds`, `maxOutputBytes`). Names are lowercase (`^[a-z][a-z0-9_]*$`) and unique among a
task's setup commands; timeouts default to 300 seconds (at most 1800) and output caps to 20,000
bytes (at most 200,000). This is how deterministic tools (Semgrep, a code graph) feed a session
without harness code. Commands run with `sh -c` in the working directory, in their own process
group (killed whole on timeout), with the harness's environment minus every `OMNIRALPH_*`
variable, so neither job token nor what the git credential helper needs. Each setup command's
stdout, cut to `maxOutputBytes` and marked when cut, becomes the untrusted variable
`setup.<name>`, fenced by the renderer (`taskVariables`/`taskCatalog` in `@omniralph/tasks` add
them to the template's available variables and the render catalog); stderr is only logged. A
failing setup command (non-zero exit, timeout) fails the run before any session starts, unless
it's `optional`: then its variable holds a one-line failure note (e.g. the exit code). Teardown
commands always run after finish, even when setup or the session failed or the run was aborted;
their output and failures are logged only and never change the run's outcome. Runs of tasks with any commands carry
`SETUP_COMMANDS_MIN_HARNESS_VERSION` as their `min_harness_version`.

Setup commands run in both lifecycles (in a review, in the head's worktree before the diff is
read) and run whatever is on the harness's `PATH`; installing tools is a later epic.

The daemon dispatches a claimed job by its task type: `system` jobs to the system RPC registry,
jobs with a run spec to their task type's lifecycle (`runQueryTask`, `runReviewTask`,
`runCodingTask`), the rest (legacy `ralph.*` jobs) to the legacy `ralph` capability. A job of an unknown type fails without retries; that includes a
leftover legacy `review.run` job without a task (migration 0063 cancels the active ones).

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
`0057_drop_capabilities.sql`). Legacy job types map with `legacyJobRouting`: `ralph.*` →
coding/long (`ralph.describe-pr` → query/short), `repo.sync` → system/no pool. (`review.run` was
review/short until TOOL-303 ported it; migration `0063_drop_legacy_review_jobs.sql` canceled
active legacy `review.run` jobs and renamed run-spec ones `review.task`.)

- **Trust:** `harnesses.accepted_task_types` (default `query`, `review`) says which task types a
  host may run. `system` jobs are always accepted. This replaces the per-harness capability toggles.
  _Since TOOL-615 the host decides: the harness's local `acceptedTaskTypes` (all by default) goes in
  every heartbeat and claim, the claim filters by it, and the control panel only stores what it
  reports (`harnesses.reported_accepted_task_types`, read-only). Migration
  `0102_harness_reported_task_types.sql` filled it from each harness's own value, else its
  organization's `tasks.allowedTypes`, else every type, then dropped `accepted_task_types` and the
  `tasks.allowedTypes` setting._
- **Concurrency:** `short` and `long` pools are seeded per organization (`pools`).
  _Since TOOL-577 a job's pool is derived from its task type (`poolForTaskType` in
  `@omniralph/shared`: `long` for coding, `short` for query and review, none for `system`):
  migration `0085_drop_job_pools.sql` dropped `jobs.pool`, its check constraint and the `pools`
  table, and task definitions no longer have a `pool`. Claims still report each job's derived pool._
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

The credential broker (`/api/harness/credentials`) decides push access by token kind and task
type: only a `coding` run's `lifecycle` token (or, on the legacy coding path, a legacy `ralph.*`
job's single token) gets a write credential. A session token never does, whatever its scopes, so a
coding run's session pushes only through the harness (`ship`); `credentials.test.ts` and
`coding-request.test.ts` prove it, and every issuance is audited with its `access` and `tokenKind`. A system RPC gets a single `lifecycle` token (it runs no session): `credentials:read`,
plus `credentials:write` for `worktree.cleanup` only, the one system RPC the broker gives a write
credential. Legacy jobs keep one token without a kind: `ralph.*` `credentials:read`,
`credentials:write`, `run:activity` and `run:attachments` (renamed from their ralph-only names). Review runs are run-spec jobs, so their sessions hold only a `session` token.
[ADR 0002](0002-agent-auth.md) has the token format and verification.

### Harness tools: the `omniralph` MCP server

Sessions reach harness primitives through an in-process MCP server named `omniralph`
(`apps/agent/src/tools/omniralph-server.ts`), which calls the control panel with the session
token:

- `ship`, offered only to request runs (not `/ship` ones): the harness commits what the session
  left (with its `message`), pushes the run's branch (`forceWithLease` only when the repository's
  **History rewrites** allows it; never another branch) and returns `{ commitSha, pushed, error }`.
  A `pullRequest` action (`open | update | ready`) on the call or in the result is performed by the
  control panel, as before. A failed push undoes the commit.
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

| Kind             | Applies                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `learned-rule`   | Stores the learned rule (skips duplicates and changed feedback)                                                           |
| `finding-thread` | Posts the reply in the finding's PR/MR thread                                                                             |
| `chat-thread`    | Posts the code answer (with file links) in the chat thread                                                                |
| `triage`         | Applies the triage output to the Linear issue (re-checks locked issues before and after the run)                          |
| `review`         | Saves a review task run's findings and summary on its review, then settles its review run                                 |
| `sticky-comment` | Posts a summary-only review task's summary to its sticky comment on the PR/MR (findings dropped)                          |
| `run-result`     | Hands a query task's result back to the run that invoked it (a review run's correlation, a ralph run's PR/MR description) |
| `ralph-run`      | Hands a coding run's story, request or push result to its ralph run (the `ralph.*` outcome hooks)                         |

Sinks stay idempotent: results can be replayed, and comments go through `postJobCommentOnce`.
Every model output is sanitized (`sanitizeCapped`) before it's posted. Sinks other than query
sinks parse their own results (`parseResult`); `run-result` accepts any query result and records a
schema mismatch as the run's failure instead of rejecting it, and `review` and `sticky-comment`
share the review job hooks (`apps/web/src/lib/review/jobs.ts`), including `onRetry`.

### Review runs

One PR/MR event (opened, pushed, `@bot review [fresh] [quick|standard|deep]`, **Re-run**) starts
one **review run** (`review_runs`: organization, repository, PR/MR, head SHA, trigger, mode,
profile, status, correlation job, summary). `enqueueReview` (`apps/web/src/lib/review/enqueue.ts`)
creates one review (`reviews.review_run_id`, `reviews.task_id`) and one `review.task` job per
review task the repository enables, all from the same `previousReviewState`, so they run in
parallel on any harnesses that accept `review` tasks.

- **Choosing tasks.** `repositories.review_task_ids` (default `{builtin:review-pr}`, 1 to 20,
  chosen under **Repository › Settings › Review tasks**, run in that order) lists the review tasks;
  one whose triggers don't include the event's kind is skipped, and with none left nothing is
  enqueued (`no_review_tasks`). `repositories.correlation_task_id` (default
  `builtin:correlate-findings`) is picked in the same card. Review triggers (`onOpen`, `onPush`, drafts),
  the profile and its depth apply to the whole run.
- **Dedupe and supersede.** Each task's job key is
  `review.run:<repositoryId>:<pr>:<headSha>:<taskId>`. An event for a head that already has active
  jobs is a `duplicate` of that run. A newer head skips the older head's active runs and cancels
  all their jobs, including a correlation job, before it creates its own.
- **Settling.** Every task run's end (completed, failed, canceled, or skipped as already reviewed)
  calls `settleReviewRun`, which takes a row lock on the run, so exactly one caller acts once no
  review is active: with two or more finished task runs it enqueues the correlation job in the same
  transaction (status `correlating`); with one it completes the run directly; with none it fails
  it when a task run failed or was canceled, else skips it. Summary-only reviews neither hold a run
  up nor join correlation.
- **Correlation.** The correlation task is a query task invoked by the run (trigger `run.invoked`,
  `RunInvoker { kind: "review-run", id }`) over every finished task run's findings and summary. Its
  output (`CorrelationOutput`: findings with `sourceFindingIds`, `sourceTaskIds`, severity,
  confidence, title, body and suggestion, plus a summary) has a fixed schema because posting
  consumes it. `applyCorrelation` updates the earliest source finding of each group with the merged
  fields and the union of task IDs (`findings.source_task_ids`) and marks the others `merged`
  (`findings.merged_into_finding_id`); IDs outside the run are ignored, findings it leaves out stay
  as they were, and a replay changes nothing. If correlation fails (or returns invalid output), the
  run completes and its findings post unmerged.
- **Posting.** Anything that may end a run calls `finishReviewRun`
  (`apps/web/src/lib/review/run.ts`), which posts a `completed` run once (`postReviewRunOnce`, under
  the run's row lock): an inline comment per open finding of its finished task runs, each naming the
  task(s) that reported it, and one summary comment combining the correlation summary, the names of
  the tasks that failed and the deterministic `renderSummary` stats over all task runs. A `failed`
  run gets one failure note. A fresh run then supersedes earlier open findings it raised again,
  earlier open findings are resolved only when every finished task run found them fixed and none
  raised them again, and a ralph PR/MR's open findings go to its run once per review run. The run's
  findings never supersede each other. Calling it again (a replayed result) is safe and retries a
  failed post.
- **Sticky comments.** A summary-only review task (sink `sticky-comment`) posts its summary to one
  comment per PR/MR and task (`sticky_comments`), edited in place on later pushes through
  `ScmAdapter.upsertComment` (GitHub issue comment, GitLab MR note), and recreated when someone
  deleted it. Its findings are dropped (and logged); a superseded run's summary isn't posted. A run
  of only summary-only tasks posts no review.

So adding a review task (a security reviewer, say) is a definitions-only change: a `review` task
(built-in, or one of the organization's own playbooks), picked per repository.

### System RPCs

`repo.sync`, `worktree.exec`, `worktree.cleanup` and `install` are system RPCs (`apps/agent/src/rpc/`,
`SYSTEM_RPCS` in `@omniralph/shared`): fixed commands with no Claude session, no run spec and no
session token, usually targeted at one harness, with a single `lifecycle` token (`credentials:read`). They use the same claim, lease,
result and fail plumbing as every other job. `worktree.exec` runs a manual story's approved
`cyralph-prepare` commands in the lane's branch worktree on the run's sticky harness (on both
coding paths, replacing `ralph.prepare`): nothing runs if the commands' hash or the branch HEAD
changed since the approval, then `bash -lc` one at a time, stopping at the first failure, without
the job token (no git credential). `worktree.cleanup` (replacing `ralph.cleanup`, same payload,
result and actions) cleans up a lane on the run's sticky harness: `cleanup` stashes the
worktree's changes, removes it and deletes the local branch unless it has unmerged commits (after
a merge), or keeps the branch (`keepBranch`, after a PR closed without merging or a stopped run);
`stashes` pushes leftover stashes to `ralph/stash/<epic>` or drops them; `branch` pushes a kept
branch or deletes it. Its payload can also list a finished run's hidden refs
(`refs/omniralph/runs/<run>`, `hiddenRefs`, with or without an action), which it deletes on
`origin`; a job with only hidden refs targets no harness, since any harness can delete them. Its
token is the only system RPC token with `credentials:write`, for those pushes; nothing in it
deletes a remote branch. `install` installs an installable on one harness (see
[Installables and host tools](#installables-and-host-tools)). Self-update stays on the
heartbeat. Two differences from the design: the keep-branch cleanup and the hidden refs were added by TOOL-377 and TOOL-378, and a hidden-refs-only
job is the one system RPC not pinned to a harness.

### Organization definitions

TOOL-306 lets organization admins add their own agents and tasks (a security reviewer with its own
rubric, a research agent) without a deploy. The user guide, with every field and validation rule,
is [docs/definitions.md](../definitions.md).

_Since TOOL-598 an organization's own definitions are **playbooks**: `agent_definitions` and
`task_definitions` are replaced by one `playbooks` table (`id`, `organization_id`, `name`, `role`,
`definition`, `requirements`; migration `0097_playbooks`, which refuses to run while a custom agent
or task, or a setting naming a custom ID, would be lost). The repo columns are
`review_playbook_ids`, `correlation_playbook_id`, `story_playbook_id` and `request_playbook_id`.
The Settings › Agents and Settings › Tasks pages and their `/api/ui` handlers are gone; playbooks
are served under `/api/ui/playbooks` (`apps/web/src/lib/playbooks/manage.ts`), resolved by
`apps/web/src/lib/playbooks/index.ts`, validated by `validatePlaybookAgainst` and protected from
deletion by `findPlaybookReferrers`. The bullets below describe the TOOL-306 design._

- **Tables.** `agent_definitions` and `task_definitions` (migration `0070_agent_task_definitions`):
  organization, UUID `id`, `name`, the definition as `definition` jsonb (without its ID and name,
  which the columns hold), timestamps and `created_by`/`updated_by`; task rows also store
  `requirements` jsonb. Every helper (now `packages/db/src/playbooks.ts`) takes the organization and
  returns nothing for a non-UUID ID, so built-in IDs never reach Postgres and one organization never
  sees another's rows.
- **Resolver.** `apps/web/src/lib/playbooks/index.ts` merges the built-ins (code) and the
  organization's rows: `getAgentDefinition`, `getTaskDefinition`, `listAgentDefinitions`,
  `listTaskDefinitions` (filtered by task type, trigger or a predicate) and
  `organizationDefinitions(db, organizationId)`, the `DefinitionSource` every enqueue, claim
  (`resolveRunSpec`), sink and settings path uses. A `builtin:` ID only resolves from code and a UUID
  only from the organization's rows, so they can't clash, and a stored row that no longer parses is
  unresolvable (its runs fail at claim like an unknown task). No code path is built-in only.
- **Save-time validation.** `validateAgentDefinition` and `validateTaskDefinition`
  (`packages/tasks/src/validate.ts`) run the zod schemas, then the static checks: triggers the task
  type accepts; the template parses and every variable is available for every trigger (a coding
  task accepting a request trigger keeps `epic.prd` and `story` in optional sections); variable
  limits; the agent exists and suits the task type and its harness tools; the output schema is an
  object schema `z.fromJSONSchema` accepts (query tasks only); the sink takes the task type and its
  output (`outputSchemaProblem` compares the task's schema with the sink's); coding settings combine
  and the PR description task outputs `{ title, body }`. Errors are keyed by field path, the format
  of `fieldErrors`. The Settings › Agents and Tasks handlers called them through
  `validateOrganizationTask` (the organization's agents and tasks, the real sinks), admins only. A test runs every built-in (and its clone) through the same validation.
- **Stored requirements.** A task save derives `TaskRequirements` (`deriveTaskRequirements`: the
  minimum harness version for the task type, commands and template variables; the installables and
  host tools of the task's `requires` and of its agent's `<package>:<server>` MCP servers) and
  stores them with the row. `taskJobInput` puts the minimum version on every job of the task
  (`jobs.min_harness_version`), and the installables and host tools derived from the task and its
  agent at enqueue time (`deriveHarnessRequirements`; `jobs.required_installables`,
  `jobs.required_host_tools`), so the claim path filters harnesses without deriving anything again.
- **Built-ins stay read-only.** Changing one is a code change; **Clone** copies one (or a custom
  definition) into a new UUID row. A custom task may name a built-in agent and follows it as it
  changes.
- **References.** Repository settings (review tasks, correlation, story and request tasks), chat
  task settings and coding tasks' PR description task may name custom tasks (pickers use
  `listTaskChoices` with a filter per role; saves re-check with `getTaskChoice`).
  `findTaskReferrers` (now `findPlaybookReferrers`) lists them, so deleting a task
  (or changing its type) is refused while anything uses it, and deleting an agent while a task runs
  on it.

### Installables and host tools

TOOL-307 lets tasks use software on the host without a harness release per tool. The guide for
installable authors, admins and harness owners is [docs/installables.md](../installables.md).

- **Installables** are npm packages whose `package.json` has an `omniralph` field
  (`InstallableManifest` in `packages/tasks/src/installables.ts`: `commands`, stdio `mcpServers`
  and `skills`, every path relative to and inside the package). npm packages rather than Claude
  Code plugins, because later non-Claude runtimes won't share a plugin format.
- **The `install` system RPC** (`apps/agent/src/rpc/install.ts`), targeted at one harness by an
  admin, installs `<name>@<version>` (exact version or dist-tag; never a path, URL or alias) into a
  harness-managed npm prefix, `<dataDir>/installables`, not `npm -g`. It is remote code execution
  on the host, so the harness checks its local `installables.allow` (default `@omniralph/*`)
  before npm runs, whatever the control panel allowed, and removes a package without a valid
  manifest again (or restores the previous version). npm runs with the harness's environment, never
  a job's credentials.
- **The heartbeat** reports the installed installables (`{name, version}`, the prefix's own
  dependencies with a valid manifest; `harnesses.reported_installables`) and the host tools.
  Self-update stays on the heartbeat too; it is not an RPC.
- **Host tools** are installed by hand. The organization's catalog (`host_tools`) and per-harness
  configured paths (`harness_host_tools`) go out in the heartbeat response; the next heartbeat
  reports whether each configured path is a usable executable and what the harness discovered on
  its own `PATH`. The effective path is the configured one if it exists, else, with none
  configured, the discovered one: a configured but missing path makes the tool unavailable rather
  than falling back to `PATH`. Paths under the local `blockedExecPaths` (compared after resolving
  symlinks) are never reported usable, and each run checks its host tools, installable commands
  and MCP servers against them again before it starts.
- **Claims** filter on `jobs.required_installables` and `jobs.required_host_tools` (see
  [Organization definitions](#organization-definitions)): a harness claims a run only if its last
  heartbeat reported every installable and it has an effective path for every host tool.
- **Running them.** Before checkout, the lifecycles resolve the run's executables
  (`resolveRunExecutables`, `apps/agent/src/lifecycle/executables.ts`): host tools by their
  effective path, installable commands and MCP servers by absolute path inside the prefix. A setup
  or teardown command whose first word names one runs that path, never what the run's `PATH`
  (which the checkout can influence) finds; agents list installable MCP servers as
  `<package>:<server>`. Something missing since the claim retries the job after a minute.
- **Caches.** Installable commands and MCP servers get `OMNIRALPH_CACHE_DIR`
  (`<dataDir>/cache/<package>/<repository id>/`) and, on PR triggers, `OMNIRALPH_PR_CACHE_DIR`
  (`<dataDir>/pr-cache/<package>/<repository id>/<number>/`, a separate tree, so data derived from
  an untrusted PR can't poison the repository's shared cache). Caches are best-effort and local:
  nothing is stored in the control panel, and a run on another harness starts cold.
- **Skills** (TOOL-420). A run opts into an installable's skills by requiring the installable (the
  task's `requires.installables`, or an MCP server of it the agent lists): no separate per-agent
  skill list, since a task that needs an installable's tools needs its instructions too. Claude Code
  loads skills only from settings or plugins, and most sessions load no settings, so the harness
  copies each required installable's skills into a plugin it writes itself
  (`apps/agent/src/installable-skills.ts`: `<dataDir>/skill-plugins/<plugin>-<content hash>/`,
  skills only) and passes it as a local plugin with MCP discovery off; sessions without settings
  enable exactly those skills. No other settings are loaded.
- **Not built:** an uninstall RPC, and pruning caches and skill plugins.

### What later epics add

TOOL-302 built the plumbing and the query task type, TOOL-303 the review task type and review
runs, TOOL-304 the coding task type and coding runs, TOOL-306 organization definitions and
TOOL-307 installables and host tools. Not built yet:

- deleting the legacy `ralph.*` job types, capability code and single tokens, once a coding run has
  merged a real PR (a follow-up issue); chat runs are covered by it too, since the responder's
  `start_work` starts coding runs of a coding task chosen in the chat settings
  ([ADR 0005](0005-chat-front-door.md#addendum-the-responder-runs-harness-tasks));
- planned reviews: a review task fanning out internally by diff group or check type
  ([TOOL-33](https://linear.app/thefrakinship/issue/TOOL-33/plan-based-code-reviews)), on top of
  review runs;
- a chat tool to run tasks.

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
- **One session per review run with every task's rubric.** Cheaper, but tasks couldn't have their
  own agent, model, budget or setup commands, and one task's failure would fail the whole review.
  Separate task runs plus a correlation step keep tasks independent; a failed task is named in the
  summary instead.
- **Deterministic correlation** (merging findings by path and overlapping lines). Misses the same
  issue reported at different lines and wrongly merges different issues on one line; a query task
  sees the findings' text. Its failure only costs the merge, never the review.
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
5. **Review runs need more than one merge step** (e.g. planned reviews whose parts must be merged
   before correlation, or a correlation that needs the code). Correlation is a single query task
   without a checkout and with a fixed output schema; changing either changes posting.

## Consequences

- Adding or changing a query or review task is a change to definitions in `packages/tasks`, with
  no harness code. The harness's `capabilities/` no longer has `chat-ask.ts`, `reply.ts`,
  `learn-rule.ts`, `triage/` or `review.ts`; only `ralph` is left, running the legacy
  `ralph.prepare` and `ralph.cleanup` jobs queued before they became system RPCs.
- Two coding paths coexisted until TOOL-576 (2026-10-25) deleted the legacy one: every repository's
  stories, requests and PR/MR descriptions are coding and query runs, `repositories.coding_path` is
  gone (migration `0084`, which also cancels active legacy story, request and describe jobs), and
  the harness no longer runs `ralph.story`, `ralph.request` or `ralph.describe-pr` jobs.
- A PR/MR with several review tasks costs a session per task plus one correlation session per
  head, and its review waits for the slowest task. Reviews need harnesses on 0.10.0 or later.
- Trust, concurrency and persona are configured separately: **Harnesses › <harness>** sets
  accepted task types and pool limits, and the task definition sets the agent and pool.
- The claim route does more work (resolving and signing two tokens per run-spec job).
- A Claude session of a run-spec job never holds a push credential.
- The rename needed a one-time reinstall of every host (`@omniralph/harness`, the new config
  path), since hosts on 0.8.0 can't self-update across it; see
  [deploy-harness.md](../deploy-harness.md#reinstalling-a-host-after-the-rename).
