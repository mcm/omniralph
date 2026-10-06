# ADR 0003: Ralph orchestration — one job per story, the control panel as orchestrator

- **Status:** Accepted (TOOL-32, Omniralph v2a)
- **Date:** 2026-10-06

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

Agents (`apps/agent/src/capabilities/ralph/`) run short, self-contained jobs on the `ralph-jobs`
topics, using the v1 job lifecycle, repo cache and credential broker unchanged:

- `ralph.story`: one attempt at one story in the epic's long-lived branch worktree: Claude session,
  quality gates, commit, push (with a brokered, job-scoped write credential), structured result.
- `ralph.describe-pr`: a read-only session that writes the PR/MR title and body.
- `ralph.prepare`: runs a manual story's approved `cyralph-prepare` commands.

A job's payload carries everything the session needs (PRD, story, progress log, feedback,
guidance), so an agent keeps no run state. Every completed story is pushed, so the remote branch
is the only state that matters between jobs.

### Lanes

A run works in one or more repositories. Each has a lane (`ralph_lanes`): its branch, base branch,
PR/MR and follow-up state. The lane of the run's own repository is its main lane; stories of an
epic routed to another repository by their own signals get a lane there (`ralph_stories.lane_id`).
All lanes of a run use the run's sticky agent.

### The sticky agent

A run's first job goes to the repository's pinned agent topic if there is one, otherwise to the
shared `ralph-jobs` topic. The agent that starts it is recorded as `ralph_runs.agent_id`, and every
later job of the run goes to `ralph-jobs-agent-<agentId>`. That keeps the branch worktree (and its
installed dependencies and stashed leftovers) warm on one host.

Stickiness is an optimization, not a requirement: when the sticky agent is revoked or no longer has
`ralph` enabled, the next job goes to the shared topic (or the pinned one) again, and whichever agent
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
- Replies can't reach a running session: they're stored as guidance and applied from the next
  attempt (live injection is deferred to v2b).
- Lost wake-ups (a hook that failed, a missed webhook) are repaired by the reconcile cron within
  10 minutes, not instantly.
