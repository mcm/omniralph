# ADR 0003: Ralph orchestration — one job per story, the control panel as orchestrator

- **Status:** Accepted (TOOL-32, Omniralph v2a); amended by TOOL-99 (v2b, see the [addendum](#addendum-v2b-request-mode-lanes-live-messages-and-self-update)); amended by TOOL-181 (see the [addendum](#addendum-run-origin-and-the-conversation-channel)); amended by TOOL-304 (see the [addendum](#addendum-coding-runs-and-the-cutover-switch))
- **Date:** 2026-10-06

> **Superseded in part by [ADR 0008](0008-agents-tasks-and-the-harness.md):** job-token scopes.
> Run-spec jobs get a `lifecycle` and a `session` token (see ADR 0008 and
> [ADR 0002](0002-agent-auth.md)); the `ralph:activity` and `ralph:attachments` scopes below are now
> `run:activity` and `run:attachments`, and the activity, permission and attachment routes accept
> any running job whose token has them, not only ralph jobs. `ralph.*` jobs keep one token with
> `credentials:read`, `credentials:write`, `run:activity` and `run:attachments` on the legacy
> coding path; on the `tasks` path (TOOL-304, [addendum](#addendum-coding-runs-and-the-cutover-switch))
> story and request runs are `coding` runs whose session token can't push. They run on harnesses
> that accept the `coding` task type, in the `long` pool, instead of on the `ralph` capability. Since TOOL-303 a review is a review run (one
> task run per review task, see [ADR 0008](0008-agents-tasks-and-the-harness.md#review-runs)), and
> the `review.run` outcome handler below is gone: `finishReviewRun` hands a completed review run's
> open findings to `respondToReview`, once per review run (`handled_review_ids` holds review run
> IDs).

## Context

cyralph runs the "ralph loop" as a standalone webhook server: it takes a delegated Linear epic,
runs each sub-issue as one unattended Claude session, runs the quality gates, commits, pushes and
finally opens a PR/MR. Its state lives in a local `sessions.json`, it holds host `gh`/`glab` logins
and Linear tokens, and it runs the whole epic in one long process.

Omniralph v2a makes this loop a second capability, `ralph`, next to `review`. Agents only make
outbound calls to the control panel, hold no code-host or Linear API tokens, and can crash, be
revoked or be redeployed at any time. A run lasts hours and spans many Claude sessions; Linear
webhooks (replies, issue state changes) and job outcomes arrive concurrently.

[ADR 0001](0001-job-dispatch.md#breaking-points-revisit-this-decision-when) named
"multi-step orchestration" as breaking point 2 for the job dispatch design, with "evaluate Vercel
Workflows first". This ADR is that evaluation and the decision.

## Decision

### One job per story; the control panel orchestrates

The control panel (`apps/web/src/lib/ralph/`) owns the loop. It receives Linear webhooks, loads and
materializes the epic, routes it to a repository, keeps run and story state in Postgres
(`ralph_runs`, `ralph_lanes`, `ralph_stories`), selects the next story, enqueues jobs through the existing
`JobDispatcher`, applies their outcomes, talks to Linear and opens the PR/MR through typed
`ScmAdapter` operations.

Agents (`apps/harness/src/capabilities/ralph/`) run short, self-contained jobs on the `ralph-jobs`
topics, using the v1 job lifecycle, repo cache and credential broker unchanged:

- `ralph.story`: one attempt at one story in the epic's long-lived branch worktree: Claude session,
  quality gates, commit, push (with a brokered, job-scoped write credential), structured result.
  On the `tasks` coding path it's a coding run of the repository's story task (see the
  [addendum](#addendum-coding-runs-and-the-cutover-switch)).
- `ralph.describe-pr`: a read-only session that writes the PR/MR title and body (on the `tasks`
  path, a run of the story task's PR description query task).
- `ralph.prepare`: runs a manual story's approved `cyralph-prepare` commands (now the
  `worktree.exec` system RPC, same payload, result and guards; ADR 0008).

A job's payload carries everything the session needs (PRD, story, progress log, feedback,
guidance, the IDs of its Linear attachments), so an agent keeps no run state beyond caches.
Linear attachments are gathered by the control panel from the run's Linear text and recorded on
the run (`ralph_runs.attachments`: ID → upload URL); agents download those listed in their job's
payload through `GET /api/harness/jobs/{id}/attachments/{attachmentId}` (job scope
`ralph:attachments`), which the control panel proxies with its Linear token. Every completed story is pushed, so the remote branch
is the only state that matters between jobs (a coding task that pushes only at the end pushes
each story to the run's hidden ref instead; see the addendum).

### Lanes

A run works in one or more repositories. Each has a lane (`ralph_lanes`): its branch, base branch,
PR/MR and follow-up state. The lane of the run's own repository is its main lane; stories of an
epic routed to another repository by their own signals get a lane there (`ralph_stories.lane_id`).
All lanes of a run use the run's sticky agent. A story's job runs with its lane's repository,
branch, base, settings and quality gates. At the finish, every lane with commits (or a PR/MR) is
published with its own `ralph.describe-pr` job, one at a time (a run has at most one job);
`ralph_lanes.publish` records each lane's progress (`describing`, `published`, `failed`), so a
reply after a failure retries only the lanes that failed, and a new story in a lane clears it.

### Requests and run modes

A run has a mode (`ralph_runs.mode`): `epic` (a delegation, or `/ralph`) builds the epic story by
story; `request` (an @mention) only does what it is asked. Requests are `ralph_messages` of kind
`request` without a job, per lane (none: the main lane). They run as `ralph.request` jobs, one per
lane with requests, main lane first, under the same one-job-per-run rule; `ralph_runs.request_job_id`
points at the one whose outcome isn't applied yet, and `request_output` collects what they said
until the run's next response. In epic mode a reply is guidance and a request: the next story job
consumes it, and when no story runs (all done, or waiting on blockers) it runs as a request. The
agent never calls the code host: a request session returns the PR/MR change it wants
(`pullRequest`) and the control panel makes it. Its Claude session is resumed by the lane's next
request only on the agent holding its files (`request_agent_id`), which the job's target agent
decides. A `pre-push` hook in the agent's repository cache keeps a branch worktree to its own
branch: a guardrail, not a boundary, since sessions bypass permissions.

PR/MR follow-up adds requests from the code host without new triggers: the `review.run` outcome
handler hands a completed review of a ralph lane's PR/MR to `respondToReview` (at most once per
review, via `ralph_lanes.handled_review_ids`, capped by `review_rounds`), and `@bot fix` / `@bot`
comments on a ralph PR/MR add a request to that lane. Either goes to the lane's running
`ralph.request` job through the live-message path, or stays pending for the next request job;
story jobs never get them, because story agents don't push.

Failed CI is the one follow-up that needs its own trigger: GitHub `workflow_run` (completed) and
GitLab Pipeline Hook webhooks (verified and deduped like the others, ignored unless they name a
ralph lane's PR/MR or branch) and the reconcile cron, which checks every open ralph PR/MR, all call
`respondToCi`. It reads the CI status and the failed jobs' log tails from the code host (outside the
run lock), skips runs with an active job (they may push again; the next check catches up), and
acts once per head SHA (`handled_ci_shas`), capped by `ci_fix_rounds`, by adding a pending request
on the lane and advancing the run.

Cleanup after a merge runs as a `worktree.cleanup` system RPC (formerly a `ralph.cleanup` job,
same payload and result; ADR 0008), because only the run's sticky agent has the
branch worktree (and the stash list) on disk. Every check that finds a ralph PR/MR merged goes
through `recordClosedPullRequest`, which starts it: the merge webhook, a Linear issue moving to
completed, the review and CI follow-ups, and the reconcile cron (the fallback). It is one of the
run's jobs (`ralph_run_id`, so `advanceRun` waits for it) but has its own dedupe key per lane and
runs after the run is over too; while another job of the run is active, the lane's cleanup waits
(`pending`) and starts when that job finishes. The questions about leftovers (unapplied stashes, a
branch with unmerged commits) are stored in `ralph_lanes.cleanup`, answered by replies in the
run's session, and carried out by further `worktree.cleanup` RPCs; the cron deletes a kept branch
whose question timed out (`unmergedBranchTimeoutMinutes`). Agents never get a code-host token for
this: pushes go through the RPC's write-scoped git credentials (its lifecycle token is the only
system RPC token that may push), as for stories.

### The sticky agent

A run's first job goes to the repository's pinned agent if there is one, otherwise to any ralph
agent of the organization. The agent that starts it is recorded as `ralph_runs.agent_id`, and every
later job of the run is targeted at it (`jobs.target_agent_id`;
[ADR 0006](0006-postgres-job-queue.md), which replaced the per-agent topics). That keeps the branch worktree (and its
installed dependencies and stashed leftovers) warm on one host.

Stickiness is an optimization, not a requirement: when the sticky agent is revoked or no longer has
`ralph` enabled, the next job goes to any ralph agent (or the pinned one) again, and whichever agent
takes it recreates the worktree from the pushed remote branch.

### Attempts vs deliveries

Two retry mechanisms, kept apart:

- **Deliveries** are the queue's. A crash or lapsed lease redelivers the same job; the redelivery is
  part of the same attempt (ADR 0001's `delivery_count`, `MAX_JOB_DELIVERIES` = 3). Claude rate
  limits are retried the same way (`RetryableJobError`).
- **Attempts** are the orchestrator's. A story job that ends `incomplete` or `blocked`, or fails, is
  one recorded attempt (`ralph_stories.attempts`, with its feedback). The orchestrator enqueues a
  **new** job for the next attempt, with that feedback in the prompt, up to `maxAttemptsPerStory`
  (3); then the story is `exhausted` and independent stories continue. A job that reaches
  `MAX_JOB_DELIVERIES` (or expires, or is canceled) counts as a failed attempt.

### The run lock and `advanceRun`

Exactly one job per run is queued or running at a time. Every state change of a run goes through
one idempotent function, `advanceRun(runId)`, which takes a row lock on the run
(`SELECT … FOR NO KEY UPDATE`, via `lockRun`) and then:

1. applies the outcomes of finished jobs it hasn't applied yet (story, describe-pr, prepare);
2. returns if the run still has a queued or running job;
3. re-reads the stories from Linear, then enqueues the next story, the describe job or a prepare job,
   or completes, or waits (recording `waiting_on` and asking in Linear).

Webhooks (new session, replies, issue state changes), job outcome hooks
(`onStarted`/`onCompleted`/`onFailed`/`onCanceled`), the Ralph runs page's stop action and the
`/api/cron/ralph-reconcile` sweep (every 10 minutes, for lost wake-ups) all just call
`advanceRun`, so they can race freely: the lock serializes them, and a second caller finds the work
already done. `FOR NO KEY UPDATE` rather than `FOR UPDATE`, because enqueueing inserts a `jobs` row
with a foreign key to the run from the dispatcher's own connection, and `FOR UPDATE` would block
that insert's `FOR KEY SHARE` check and deadlock.

Linear's 10-second rule is handled outside the lock: the webhook posts a `thought` acknowledgement
synchronously and does the rest after the response (`after()`).

## Alternatives considered

### Vercel Workflows (considered, deferred)

A durable workflow per run (`"use workflow"`, steps, `sleep`, hooks for replies and job outcomes)
would express the loop as straight-line code with durable waits, instead of a state machine
re-entered from many places.

Deferred, because:

- **The long work isn't in the control panel.** Each step is an agent job that takes minutes to
  hours on a Coder host, so a workflow would still dispatch through the queue and wait on a hook for
  the outcome. It would replace `advanceRun`'s state machine, not the queue, the job lifecycle or
  the agent protocol, and we'd run two durability mechanisms side by side.
- **State must stay queryable and editable.** The Ralph runs pages, the stop action, replies that
  reset attempts and "start anyway" all read and change run state directly. With a workflow, that
  state lives in the workflow's event log, and every such change becomes an event that the
  workflow has to handle.
- **Versioning.** Runs last hours to days across many deployments. In-flight runs would be bound to
  the code version that started them (or need careful replay compatibility). Postgres rows plus an
  idempotent `advanceRun` simply pick up the newest code.
- **Maturity and testability.** Workflows were in beta when this was decided. The Postgres design
  is tested end to end with Testcontainers and a fake Linear, with no Vercel-specific runtime in
  tests.
- **Small marginal gain.** With one job per run at a time, the race handling is one row lock and
  one idempotent function.

**Revisit when:**

1. A run needs real fan-out/fan-in: several stories (or lanes in several repositories) in parallel
   with joins, which a single "one job per run" lock can't express.
2. Durable timers and long waits multiply beyond the 10-minute reconcile cron: scheduled retries,
   per-step timeouts, or waiting on CI and reviews (the v2b review-response and CI-fix loops are a
   likely trigger).
3. `advanceRun` grows enough phases that its state machine is harder to reason about than
   straight-line workflow code, or orchestration bugs (lost wake-ups, double enqueues) keep
   appearing.
4. Vercel Workflows becomes generally available with a versioning story for long-running
   instances, and Omniralph adopts it elsewhere (e.g. if ADR 0001's dispatch is revisited).

The `JobDispatcher` and the agent's job contract don't depend on the orchestrator, so moving the
loop into a workflow would only replace `apps/web/src/lib/ralph/run.ts` and its callers.

### One job per run (cyralph's model on an agent)

Ship cyralph's whole epic loop as one long agent job. Rejected: a job would hold a lease for hours
and lose all progress on a crash or redeploy; it would need Linear and code-host API access on the
agent (or a chatty relay for every plan update, comment and PR call); replies and stop would have
to reach a running process; and the Jobs page, cancellation and per-story history wouldn't map to
anything.

### The agent orchestrates, the control panel stores

Let agents decide the next story and call back to store state. Rejected: it spreads the loop over
two codebases and many hosts, needs Linear reads on the agent, and makes a revoked agent's run
depend on that agent's local state.

## Consequences

- Run state is ordinary Postgres rows, shown on the Ralph runs pages and changeable by admin
  actions and replies, with all changes serialized by one lock.
- Every story costs a fresh Claude session plus worktree setup; the sticky agent keeps the setup
  cost to once per run in the common case.
- A run moves to another agent after a revocation without losing completed stories, because every
  completed story is pushed before its job reports.
- Replies reach a running `ralph.story` or `ralph.request` session within one heartbeat (v2b, see
  the addendum); otherwise they're stored as guidance or pending requests and applied from the
  next job.
- Lost wake-ups (a hook that failed, a missed webhook) are repaired by the reconcile cron within
  10 minutes, not instantly.

## Addendum (v2b): request mode, lanes, live messages and self-update

TOOL-99 closed the gap to cyralph without changing the decision above: the control panel still
orchestrates, agents still run one short job at a time per run, and every change still goes
through `JobDispatcher`, the per-capability outcome handlers, `advanceRun` and the run lock. The
sections *Lanes* and *Requests and run modes* above describe the details; this is the summary.

- **Request mode.** `ralph_runs.mode` is `epic` or `request`. An @mention creates (or reuses) a run
  in `request` mode: no story loop, no Linear state changes, no blocker checks. Requests run as
  `ralph.request` jobs (one Claude session on the lane's branch worktree). The session never calls
  the code host; it returns `pullRequest: { action: open | update | ready }` and the control panel
  performs it with the SCM operations, sanitizing the text. A lane's Claude session is resumed only
  on the agent that holds its files (`request_agent_id`). `/ralph` switches a run to `epic`. In
  epic mode, push/PR requests never reach a story agent: they wait until no story runs. Review
  findings, `@bot fix` requests and failed CI become requests on their lane the same way.
- **Lanes.** `ralph_lanes` (one per repository a run works in, the run's own being the main lane)
  replaced v2a's run-level branch and PR columns; `ralph_stories.lane_id` records where each story
  runs. Lanes keep PR/MR follow-up state (`review_rounds`, `handled_review_ids`, `ci_fix_rounds`,
  `handled_ci_shas`, cleanup) and are published one at a time. All lanes use the run's sticky
  agent, so "one job per run" still holds: lanes run in sequence, not in parallel (the first
  *Revisit when* condition is still unmet).
- **Live messages.** A reply or request for a run whose `ralph.story` or `ralph.request` job is
  running is stored in `ralph_messages` with that job's ID. The heartbeat response carries it
  (`jobMessages`); the agent injects it into the live session as a streamed user message
  (`priority: "next"`) and acknowledges it in its next heartbeat (`deliveredMessageIds`, or
  `rejectedMessageIds` when the job is past its session, e.g. running its gates). Rejected and
  stranded messages become guidance (epic mode) or pending requests, settled by `advanceRun` when
  the job ends. No new endpoint or polling: delivery takes at most one heartbeat (20s).
- **PR/MR follow-up without new orchestration.** Review responses hang off the `review.run`
  outcome handler; CI failures and merges arrive by webhook with `/api/cron/ralph-reconcile` as the
  fallback; cleanup is a `worktree.cleanup` system RPC on the sticky agent. These are the "waiting
  on CI and reviews" loops the second *Revisit when* condition anticipated. They fit the state machine as
  pending requests plus once-per-review/SHA bookkeeping and the existing 10-minute cron, so Vercel
  Workflows stays deferred.
- **Attachments.** The control panel gathers Linear upload URLs and records them on the run; agents
  download them through a job-scoped proxy (`ralph:attachments`), so they still never hold the
  Linear token.
- **Concurrency.** `agents.capability_limits` caps concurrent jobs per capability (ralph defaults to
  `max(1, maxConcurrency - 1)`), sent in the heartbeat config. The daemon only claims a
  capability's jobs while it has a free slot, so long ralph jobs can't starve reviews.
- **Self-update.** cyralph's git-following supervisor (`src/update/*`) is replaced by a desired
  version (global in `app_settings`, per-agent override in `agents.desired_version`) returned in
  the heartbeat. Agents under pm2 drain (up to 2 hours), `npm i -g` the version, write
  `update-state.json` and exit for pm2 to restart them; a version that doesn't stay up for 60s
  within three starts is rolled back and reported as failed, never retried. Other hosts report
  `selfUpdate: "unsupported"`. The control panel only stores and shows these reports; it never
  reaches into agents.

The cutover from cyralph itself is an operator checklist, not code:
[cutover-from-cyralph.md](../cutover-from-cyralph.md).

## Addendum: run origin and the conversation channel

TOOL-181 lets a run belong to a Slack or Discord thread instead of a Linear issue, so the chat
control-panel agent ([ADR 0005](0005-chat-front-door.md)) can hand work to ralph. The loop itself
is unchanged: chat runs go through the same jobs, outcome handlers, `advanceRun` and run lock.

- **Run origin.** `ralph_runs.origin` is `linear` (the default; every earlier run) or `chat`, with
  `chat_thread_id` pointing at `chat_threads`. The Linear columns (issue, identifier, agent
  session) are nullable, and a CHECK requires them for Linear runs. The CHECK doesn't require
  `chat_thread_id` for chat runs: its FK is `on delete set null`, and disconnecting a workspace
  cascades to its threads, so `createRun` requires the thread instead. "One active run per issue"
  became two partial unique indexes: per issue for Linear runs, per chat thread for chat runs.
  `NewRalphRunInput` is a discriminated union; code narrows with `isLinearRun` / `linearSessionOf`
  and names runs with `runReference` (`ENG-1` or `chat-<id8>`), never by asserting the Linear
  fields.
- **Chat runs are request mode only.** `start_ralph_request` creates a `single`/`request` run in a
  ralph-enabled repository the agent named (validated against the organization's repositories; no
  Linear routing) on a lane `omniralph/chat-<id8>`, or reuses the thread's previous run's lanes
  for the same repository. `step()` gives it a synthetic epic (no stories, no attachments), skips
  every Linear-only step (epic load, story sync, state changes, follow-up filing, completed-epic
  move, repository elicitation, `/ralph`) and completes it through `finishRequests`. Epics stay in
  Linear.
- **`RunConversation`.** Every session write (`notify`, `start`, `publish`, `run`, `activities`,
  `requests`, `messages`, `repository-selection`, `ci`, `pull-request-requests`, `cleanup`, …) goes
  through `RunConversation` (`apps/web/src/lib/ralph/conversation.ts`: `post`, `updatePlan`,
  `addLink`), chosen per run by `conversationFor(run, deps)`. `LinearConversation` writes agent
  activities, plans and external URLs exactly as before. `ChatConversation` posts proactively,
  outside any webhook: it rebuilds the thread from `chat_threads` and, for Slack, runs the call
  under the bot token from `chat_connections` (`withBotToken`). To keep the thread readable it
  edits one status message per request job for thoughts, actions and plan changes, and posts only
  responses, elicitations, errors, links and PR/MR follow-up notices (`PostOptions.notice`) as new
  messages, sanitized and recorded in `chat_messages` with `ralph_run_id`. Its own state (status
  message, posted links) lives in the Chat SDK state, not `ralph_runs`, so a post never contends
  with the run lock.
- **Linear only on demand.** `RalphDeps.linear` is a lazy gateway (`lazyLinearGateway`): chat-run
  paths never load or refresh a Linear token, and organizations without Linear can run chat runs.
- **Reply routing** lives in the chat agent's handler: while the thread's run has a queued or
  running `ralph.request` job, a linked member's plain reply takes the Linear reply path
  (`queueLiveReply`, else `addInstruction` + `advanceRun`) and reaches the session within one
  heartbeat; a reply that mentions the bot goes to the control-panel agent. The agent can also add
  guidance to any run of the organization (`send_ralph_guidance`, the same `addInstruction` path),
  but can't stop runs.

Alternatives considered: a separate chat-runs table (would duplicate lanes, requests, messages and
PR follow-up bookkeeping that already hang off `ralph_runs`); mirroring every thought into chat as
Linear does (too noisy for a channel); and posting from a background job per message (the
conversation call is cheap and already runs where the activity arrives).

**Update (TOOL-305, 2026-10-12).** The chat responder now fronts chat-origin runs
([ADR 0005's addendum](0005-chat-front-door.md#addendum-the-responder-runs-harness-tasks)), which
changes two points above:

- `ChatConversation` records events instead of posting for chat-origin runs: responses, notices
  and links become `response` events, elicitations `question`, errors `failure`
  (`recordChatRunEvent` into `chat_run_events`); permission requests, cleanup questions and the
  run's completion and failure are recorded the same way. Thoughts, actions and plan changes record
  nothing, and the status message is gone. The responder relays the events in wake-up turns.
  `start_ralph_request` became the responder's `start_work`, which runs the channel's "start work"
  coding task (`ralph_runs.coding_task_id`).
- Reply routing moved into the responder: the handler sends every message to the model, which
  passes replies and answers on with `reply_to_run`, `answer_run_permission` and
  `answer_run_cleanup`.

Linear-delegated runs started from chat are Linear runs and are unchanged: they keep their
`chat-notify.ts` notices (`apps/web/src/lib/ralph/chat-notify.ts`) in the thread.

## Addendum: coding runs and the cutover switch

TOOL-304 (2026-10-12) moves the loop's sessions onto the `coding` task type of
[ADR 0008](0008-agents-tasks-and-the-harness.md#coding-runs) without changing the decision above:
`advanceRun`, the run lock, one active job per run, the sticky harness, attempts vs deliveries,
story selection, Linear state changes, follow-up issues and the reconcile cron are the same on
both paths, and both share all run state.

- **The switch.** `repositories.coding_path` (**Repository › Settings › Ralph › Coding path**) is
  `legacy` (the default) or `tasks`. On `legacy`, `advanceRun` enqueues the `ralph.story`,
  `ralph.request` and `ralph.describe-pr` jobs above, run by the harness's legacy `ralph`
  capability code. On `tasks`, the same steps are run-spec jobs (`ralphJobInput`,
  `describePrJobInput` in `apps/web/src/lib/ralph/coding.ts`): story runs of
  `repositories.story_task_id` (default `builtin:implement-story`) and request runs of
  `repositories.request_task_id` (default `builtin:handle-request`), both coding tasks on agent
  `builtin:engineer`, with sink `ralph-run`. They keep the legacy job types (`ralph.story`,
  `ralph.request`, `ralph.describe-pr`), the run dedupe key and the sticky target, and carry the
  legacy payload (`buildStoryPayload`, `buildRequestPayload`, …) as their trigger context, so live
  messages, the Jobs page and the outcome hooks are unchanged; code reads a ralph job's payload
  with `ralphJobPayload(job)`. Omniralph builds itself with this loop, so the legacy path stays
  until a coding run has merged a real PR; deleting it is a separate issue.
- **Prompts.** Story and request prompts are the tasks' templates over contexts built from the same
  inputs as `buildStoryPrompt` and `buildRequestPrompt`, and render the same for the same inputs
  (snapshot and parity tests in `packages/tasks`). `builtin:engineer`'s system prompt is
  mode-neutral; epic, PRD and story wording lives only in the story task's template, and a request
  prompt never mentions them for any non-epic trigger (`request-prompt.test.ts`). Each request is
  stored with its trigger (`ralph_messages.trigger`: `linear.mention`, `chat.request`,
  `pr.review-findings`, `pr.ci-failed`, `pr.fix-command`), which picks the request task.
- **The PR description** is a run of the story task's `prDescriptionTaskId` (default
  `builtin:describe-pr` on `builtin:pr-writer`): a query task invoked by the ralph run
  (`run.invoked`, `RunInvoker { kind: "ralph-run" }`) with a fixed `{ title, body }` output, handed
  back through the `run-result` sink.
- **Pushing moves behind the harness.** On `tasks`, only a coding run's `lifecycle` token can get a
  write credential; the session's git credential helper uses its `session` token, which only ever
  gets a read credential. The story lifecycle commits and pushes after the gates, as before. A
  request session can't push by itself: it calls the `ship` harness tool, and the harness commits,
  pushes (`--force-with-lease` only when asked and **History rewrites** isn't `never`) and returns
  the outcome, recording the PR/MR action (`open | update | ready`) the control panel then
  performs. `/ship` still has the lifecycle commit and push after the session.
- **Push and draft PR timing** are story task settings: `pushTiming` `per-story` (default, today's
  behaviour) or `end`, and `draftPullRequest` `early` or `end` (unset: the repository's
  `openPullRequestEarly`). With `end`, each story is pushed to the run's hidden ref
  `refs/omniralph/runs/<run>` (which keeps the "remote is the state between jobs" property), a
  `ralph.push` job pushes the branch once every story is done, before the description, and no
  early draft PR is opened; `end` with an early draft is an invalid task (`validateCodingTask`). The
  hidden refs are deleted when the run completes or fails (a `worktree.cleanup` RPC with only
  refs, recorded in `hidden_refs`), and a daily cron prunes leftovers after 14 days.
- **Preparation and cleanup** run as the system RPCs `worktree.exec` and `worktree.cleanup` on
  both paths (replacing `ralph.prepare` and `ralph.cleanup`, which stay registered for queued
  jobs). Cleanup now also runs after a PR/MR closes without merging and after a run is stopped:
  the `cleanup` action with `keepBranch` stashes uncommitted work and removes the worktree, but
  keeps the local branch, so a resumed run carries on from it. Nothing deletes a remote branch.

A coding task's own setup and teardown commands run in story and request runs, in the branch
worktree (after the repository's **Setup command**): setup before the prompt is rendered, as
`setup.<name>`, teardown after the attempt, whatever happened.

Coding runs carry `CODING_TASKS_MIN_HARNESS_VERSION` (harness 0.11.0, the first release with
the coding lifecycle) as their `min_harness_version`: an older harness leaves them queued rather
than failing a story attempt as an unsupported task type.

The PR description query run uses the repository's ralph **Model** (and fallback model), like
`ralph.describe-pr`; the task's `opus` applies only when the repository sets none.

Alternatives considered: rewriting the loop as a new coding orchestrator (the loop's guarantees
are what this epic must not change; keeping the payloads as trigger contexts leaves `advanceRun`
as it was), and a global switch instead of a per-repository one (Omniralph's own repository has
to be able to fall back while others try the new path).
