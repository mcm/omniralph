# ADR 0006: The `jobs` table is the job queue

- **Status:** Accepted (TOOL-254). Supersedes [ADR 0001](0001-job-dispatch.md).
- **Date:** 2026-10-10

> **Superseded in part by [ADR 0009](0009-ably-wake-signals.md):** the long-poll, when
> `ABLY_API_KEY` is set. Harnesses then claim with `waitSeconds: 0` when an Ably wake message or the
> heartbeat's `claimable` flag says there may be a job, and hold no claim requests. Without the key,
> and for harnesses or control panels on older versions, the long-poll below still applies.

> **Superseded in part by [ADR 0008](0008-agents-tasks-and-the-harness.md):** capabilities. Jobs
> no longer have a `capability`; the claim selects by task type (in the harness's
> `accepted_task_types`), pool (in the claim request's `pools`) and `min_harness_version`, and
> per-pool limits (`harnesses.pool_limits`) replace per-capability limits and
> `enabledCapabilities`. `ClaimRequest` is `{ pools, waitSeconds? }` (since TOOL-615 also
> `acceptedTaskTypes`, the harness's local list, which the claim filters by). Agents are now called
> harnesses (`target_harness_id`, `/api/harness/*`). The queue, leases, retries and long-poll below
> are unchanged.

## Context

[ADR 0001](0001-job-dispatch.md) kept job state in Postgres and delivered jobs through Vercel
Queues (VQS) in poll mode. Agents may only call the control panel, so they polled VQS through the
control panel's queue proxy (`/api/harness/queue/<region>/…`). Each idle agent sent one receive per
topic every 5s. With 6 agents that came to about 310k proxied requests a day, and each was billed as
a CDN request, a function invocation and an external API request. That alone put Observability Plus
at about $30/month, and the cost grew with every agent and every capability. This is breaking point
4 of ADR 0001 ("noticeable proxy-invocation cost").

VQS also bought us less than we thought. Postgres already held everything the dispatch decisions
use: status, agent, delivery count, dedupe key, cancellation and expiry. Messages only carried
`{ jobId }`. Every delivery was checked against the `jobs` row (`POST /jobs/{id}/start`), and the
3-delivery limit was ours, not the queue's. Two copies of the same state (the message and the row)
had to agree, and the proxy needed its own allowlists, regions (`QUEUE_REGIONS`) and OIDC token.

## Decision

**Agents claim jobs straight from the `jobs` table through a long-polling control-panel endpoint.
The heartbeat agents already send renews their leases. Vercel Queues is removed.**

### Schema

`jobs` gained three columns (migration `0052_job_queue.sql`):

| Column                                                        | Meaning                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `available_at` (not null, default `now()`)                    | When a `queued` job may be claimed. A retry pushes it into the future.  |
| `lease_expires_at` (nullable)                                 | When a `running` job's lease lapses and another agent may take it over. |
| `target_agent_id` (nullable, FK `agents`, on delete set null) | Only this agent may claim the job. Replaces the per-agent topics.       |

Two partial indexes back the claim: `jobs_claim_queued_idx` (organization, status, `available_at`
where `queued`) and `jobs_claim_lease_idx` (organization, `lease_expires_at` where `running`).
`jobs.topic` and `jobs.queue_message_id` were dropped (`0053_drop_job_topic.sql`), and
`agents.poll_interval_seconds` with them (`0054_drop_agent_poll_interval.sql`).

### Dispatch

`JobDispatcher` (`apps/web/src/lib/dispatch/dispatcher.ts`) keeps its interface, so callers didn't
change. `PostgresDispatcher.createAndPublish` only inserts the row (`insertJob`, deduped by
`dedupe_key` among queued and running jobs). It sets `target_agent_id` to:

1. the explicit target (`repo.sync` names its agent; a ralph run's sticky agent), which must belong
   to the job's organization, else the dispatcher throws before inserting;
2. else the repository's pinned agent (`pinnedAgentFor`: the non-revoked pinned agent of the job's
   organization with the fewest running jobs, then the latest heartbeat);
3. else null: any agent of the organization may claim it.

`republish(jobId)` re-resolves the target of a still-queued job, e.g. after the agent it targeted was
revoked or unpinned. There is no publish step that can fail after the insert, so there's no
"inserted but not published" state any more.

### The claim

`claimJob` (`packages/db/src/jobs.ts`) runs in one transaction:

```sql
select * from jobs
where organization_id = :agentOrg
  and capability in (:requested ∩ :enabled)
  and (target_agent_id is null or target_agent_id = :agentId)
  and (   (status = 'queued'  and available_at     <= now())
       or (status = 'running' and lease_expires_at <  now()))  -- crash takeover
order by target_agent_id is null, created_at, id                -- targeted jobs first
limit 1
for update skip locked
```

- **Capabilities:** the ones the agent asked for (it leaves out capabilities at their per-capability
  limit) intersected with the ones enabled for it in the control panel (`runnableCapabilities`,
  which always allows `system`).
- **Checks on the locked row**, as the old start route did: a cancel-requested job becomes
  `canceled`, a job at `MAX_JOB_DELIVERIES` (3) becomes `failed`, and the claim moves on to the next
  candidate in the same transaction. The route then runs the job type's `onCanceled` / `onFailed`
  outcome handlers for those settled jobs.
- **Claim:** `status = 'running'`, `agent_id`, `started_at`, `delivery_count + 1` and
  `lease_expires_at = now() + JOB_LEASE_SECONDS`. The job token is signed in a `beforeClaim` hook
  inside the transaction, so a KMS failure rolls the claim back and no delivery is used up.
- **Start hook:** the route calls the outcome handler's `onStarted`. If it says `skip`, the route
  claims the next job.
- `SKIP LOCKED` lets concurrent claims (several agents, or several requests of one agent) pass
  each other without waiting; a row is only ever claimed by one of them.

### The long-poll

`POST /api/harness/claim` (`apps/web/src/app/api/harness/claim/route.ts`) takes
`ClaimRequest { capabilities, waitSeconds? }`. `waitSeconds` is 0–50 (`MAX_CLAIM_WAIT_SECONDS`,
the default). The route answers with `JobStartResponse`'s `run` shape (job plus job token, 200) as
soon as it claims a job. Otherwise it claims again every 2s until `waitSeconds` passes or the agent
hangs up, then answers 204. Route `maxDuration` is 60. Each attempt re-reads the agent, so a
revoked agent gets 401 and capability changes apply mid-wait.

With `REDIS_URL` set, each attempt first asks a per-organization Redis sorted set of when each
queued or running job can next be claimed (`job-due:{organizationId}`,
`apps/web/src/lib/dispatch/due.ts`) and only claims from Postgres (and re-reads the agent) while
an entry is due. Idle attempts read the agent's revocation from Redis instead. Dispatch, retry,
claim, lease renewal and every finish update the set after their commit; a flushed Redis is
rebuilt from the queued and running jobs. See [ADR 0007](0007-redis-hot-state.md).

The agent (`apps/harness/src/daemon.ts`, `claimLoop`) keeps one claim in flight while it has a free
slot. It starts a claimed job and claims again at once. When nothing is claimable (no free slot, or
every capability at its limit) it waits until a job ends or the configuration changes. A change to
the claimable set (heartbeat config, job end, drain, SIGTERM) aborts the in-flight claim and starts
a new one. API errors back off from 1s, doubling to 30s.

So an idle agent sends one or two control-panel requests a minute instead of about 36, and a job is
picked up within about 2s of being dispatched. Fluid compute bills provisioned memory while a
request is held, but held requests share an instance.

### Leasing through the heartbeat

`JOB_LEASE_SECONDS` is 120, six missed 20s heartbeats. The heartbeat
(`POST /api/harness/heartbeat`) already reports the agent's running job IDs. `classifyAgentRunningJobs`
splits them into the jobs to keep (running on this agent, no cancel requested) and the ones to stop
(`cancelJobIds`). `renewJobLeases` then sets `lease_expires_at = now() + 120s` on the kept ones only.
The agent sends no lease call of its own.

A crashed or disconnected agent stops heartbeating. Its jobs' leases lapse within 2 minutes, and the
next claim takes them over (counting another delivery). If the old agent comes back, its next
heartbeat lists the taken-over jobs under `cancelJobIds`, and its `result`/`fail` reports get 409
because only the job's current agent may report. A running job with a null lease is never taken
over, so everything that sets `running` sets a lease.

### Delayed retry

`POST /jobs/{id}/fail { retryable: true, retryAfterSeconds? }` below the delivery limit puts the job
back to `queued` with `agent_id` and the lease cleared and
`available_at = now() + retryAfterSeconds` (default 60). The agent only reports the failure; there's
no visibility change or acknowledgement. Non-retryable failures, and failures on the last delivery,
fail the job.

### Cancellation and expiry

Unchanged: `cancel(jobId)` cancels a queued job at once and flags a running one, which the agent
learns about from `cancelJobIds`. The claim also cancels a flagged job it comes across.
`GET /api/cron/expire-jobs` (hourly) marks jobs still `queued` 24h after creation as `expired`;
there's no message retention any more, but a job nobody claimed in a day is stale.

### Organization isolation

The claim only selects jobs whose `organization_id` is the agent's organization and whose
`target_agent_id` is null or the agent itself. A job can only be targeted at an agent of its own
organization (the dispatcher refuses a foreign explicit target and ignores a foreign pin or sticky
agent). The other agent routes (`getJobForAgent`, `isJobRunningOnAgent`) keep refusing other
organizations' jobs. This replaces the per-organization topics and the proxy's topic allowlist of
[ADR 0004](0004-organizations.md#job-isolation).

### Protocol compatibility

The heartbeat response keeps `pollIntervalSeconds`, `topics` and `queueRegion` with the legacy
values `5`, `[]` and `""` (`LEGACY_POLL_INTERVAL_SECONDS`), because agents before this change parse
it strictly. They're optional and `@deprecated` in `HeartbeatResponse`, and the new agent ignores
them. Removing them is a later cleanup.

### Cutover

One release; VQS and Postgres dispatch never run side by side. A person does this after the merge:

1. Deploy the control panel. Migration `0052` backfills `target_agent_id` from per-agent topics and
   gives running jobs a 120s lease, so queued jobs become claimable at once.
2. The heartbeat now returns `topics: []`, so old agents stop polling VQS. Their running jobs keep
   their lease through the heartbeat (old agents already report running job IDs) and report
   results as before.
3. Set `desiredVersion` (Settings › Agents) so agents update themselves and start claiming.
4. Remove `QUEUE_REGIONS` from the Vercel project. Messages left in VQS expire with their retention;
   nothing reads them.

## Alternatives considered

- **Keep VQS, poll less often.** A longer poll interval cuts the cost linearly but delays every job by
  up to the interval, and keeps the proxy and the duplicated state.
- **Keep VQS, long-poll it through the proxy.** The proxy would hold each receive and loop on VQS
  itself: fewer agent requests, but the same duplicated state, the proxy's allowlists and an
  external API call per loop.
- **Redis (or Postgres `LISTEN/NOTIFY`) to wake held claims.** Would cut the pickup latency below 2s
  and the Postgres polling of held requests. Not needed at our scale, and it's new infrastructure; a
  Redis wake signal is a separate follow-up and doesn't change the claim itself.
- **pg-boss or another queue library.** Brings its own schema and worker model, but agents can't
  reach Postgres, so the claim endpoint and leases would still be ours. The `jobs` table already
  has the state, so the queue mechanics are one query and two columns.

ADR 0001 rejected Postgres as the queue to avoid writing lease, retry and redelivery mechanics.
They turned out small: leasing is one column renewed by a request agents already send, retry is one
column, and redelivery is part of the claim query.

## Breaking points: revisit this decision when

1. **Claim load on Postgres.** Held claims query every 2s per agent. With many more agents (say
   more than 50), or claim queries showing up in Neon's slow-query or compute metrics, add a wake
   signal (Redis, or `NOTIFY` from a long-lived listener) and lengthen the retry interval.
2. **Held-request cost.** If Fluid compute's provisioned-memory time for held requests costs more
   than the request count saved, shorten `waitSeconds` or move the long-poll off Vercel functions.
3. **Scheduling needs.** Priorities, fair scheduling across repositories or organizations, or
   per-repository rate limits change the `order by` and may need their own tables.
4. **Throughput.** Thousands of jobs a minute make the single-row `FOR UPDATE SKIP LOCKED` claim
   and the `jobs` table's growth (it's also the history) a bottleneck; then partition or move queued
   jobs into a separate table.
5. **Agentless backends** (Coder tasks, Modal) need push dispatch instead of claims.

## Consequences

- One source of truth: a job's queue state and its history are the same row, and every dispatch
  decision (target, retry delay, cancellation, give-up) is a transaction on it.
- No external queue, no proxy, no `QUEUE_REGIONS`, no `@vercel/queue` or `@vercel/oidc`. The
  control panel's OIDC token is only used by KMS and the AI Gateway.
- Lease renewal depends on the heartbeat: an agent whose heartbeats fail for 2 minutes loses its
  running jobs to other agents even if they're still running. They're canceled on its next
  successful heartbeat.
- A job's pickup latency is up to 2s plus the agent's round trip, not 0–5s of poll interval.
- The 3-delivery limit is still counted by `delivery_count` on claim, so a job whose claim
  responses never reach the agent (e.g. the response is lost) uses up deliveries and fails.
