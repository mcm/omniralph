# ADR 0007: Hot state in Redis so Neon can scale to zero

- **Status:** Accepted (TOOL-266)
- **Date:** 2026-10-16

## Context

Neon bills compute for every minute it's awake and suspends only after a few minutes without a
query. Idle harnesses kept it awake around the clock. Each one sends a heartbeat every 20s and,
without Ably ([ADR 0009](0009-ably-wake-signals.md)), holds a claim long-poll that looked for a job
every 2s ([ADR 0006](0006-postgres-job-queue.md)). Every harness request also checked revocation
(`requireHarness` / `requireJob`) and its rate limits in Postgres, and the heartbeat wrote the
harness row every time. On top of that, the `ralph-reconcile` cron queried Postgres every 10
minutes and `expire-jobs` every hour, with nothing to do almost every time.

The answers to these requests hardly ever change: the harness isn't revoked, there's no job, the
heartbeat response is the same as 20s ago. What's needed is a cheap place to keep that state and
to learn when it changed.

## Decision

**A Redis (Upstash, over TCP) holds hot state for the idle paths: caches, counters and signals that
can all be rebuilt from Postgres or safely lost. Postgres stays the source of truth. Each writer
updates Redis after its Postgres commit, and every reader falls back to Postgres when Redis is
unset, unreachable or being rebuilt.**

### The client

`apps/web/src/lib/hot-state/` holds the client and the read and write helpers:

- `client.ts`: one `ioredis` client per instance, created on first use from `REDIS_URL`.
  `hotStateEnabled()` is just "is `REDIS_URL` set". A command fails after one retry and a 2s
  timeout (connect: 5s), so a caller falls back to Postgres instead of queueing behind reconnects.
- `index.ts`: `readHotState(db, fromRedis, fromPostgres)` and `writeHotState(update)`, used for
  everything derived from Postgres (below).
- `epoch.ts`: the epoch and the rebuilders.
- `rebuilders.ts`: imports every module that registers a rebuilder (see _The epoch rebuild_).
- `testing.ts`: a Redis testcontainer for integration tests, as `packages/db` does for Postgres.

### What lives in Redis, and who writes it

There are two kinds of key. **Derived** keys mirror Postgres state that idle requests would
otherwise query: they're read through `readHotState`, written through `writeHotState`, and rebuilt
when the epoch is missing. **Own** keys (counters, last-seen times, fingerprints, change counters)
aren't derived from Postgres: they're read and written with `hotStateEnabled()` and a
`try`/`catch` around the Redis call, have no rebuilder, and losing one costs at most a Postgres
query or write on the next request.

| Key                                                                      | Kind             | Holds                                                                                                                                                         | Written by                                                                                                                                                                                                                                                                                                                                                                                   | Module                           |
| ------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `hot-state:epoch`                                                        | control          | When the derived keys were last rebuilt; no TTL                                                                                                               | The rebuild; deleted by a failed `writeHotState`                                                                                                                                                                                                                                                                                                                                             | `lib/hot-state/epoch.ts`         |
| `hot-state:rebuild-lock`                                                 | control          | The rebuilding instance's token (`SET NX PX 30s`)                                                                                                             | The rebuild                                                                                                                                                                                                                                                                                                                                                                                  | `lib/hot-state/epoch.ts`         |
| `harness-auth:{harnessId}`                                               | derived          | `active` or `revoked`, 24h TTL                                                                                                                                | Readers on a miss (`SET NX`); `revoked` after `revokeHarness` and after refresh-token reuse (token route). Rebuild deletes them all                                                                                                                                                                                                                                                          | `lib/harness-auth/auth-state.ts` |
| `job-due:{organizationId}`                                               | derived          | Sorted set of queued and running jobs, scored by when each can next be claimed (`available_at`, or `lease_expires_at`)                                        | After every commit that changes a job's status, availability or lease: dispatch and cancel (dispatcher), claim, lease renewal (heartbeat), retry and fail, result, skip, revoke (requeue), expire, review correlation. Rebuilt from the queued and running jobs                                                                                                                              | `lib/dispatch/due.ts`            |
| `job-queued-since`                                                       | derived          | Sorted set of every queued job, scored by `created_at`                                                                                                        | The same writers as `job-due:*` (`syncJobsDue`); rebuilt with it                                                                                                                                                                                                                                                                                                                             | `lib/dispatch/due.ts`            |
| `ralph:active`                                                           | derived (signal) | A random value: there may be ralph work to reconcile                                                                                                          | Set after `advanceRun` (which also opens PRs/MRs) and after run creation (`start.ts`, `chat-start.ts`); compare-and-deleted by the reconcile cron when it found no work. The rebuild sets it                                                                                                                                                                                                 | `lib/ralph/active.ts`            |
| `ralph:reconciled`                                                       | own              | The last full reconcile run, 24h TTL                                                                                                                          | The reconcile cron                                                                                                                                                                                                                                                                                                                                                                           | `lib/ralph/active.ts`            |
| `ralph:backoff`                                                          | own              | `{interval}\|{due}\|{fingerprint}`: when the reconcile cron next runs a pass while ralph work exists, and the work's fingerprint after the last pass, 24h TTL | The reconcile cron after a pass with work left; deleted by `markRalphActive` outside the cron's pass, by a pass that found no work and by the rebuild                                                                                                                                                                                                                                        | `lib/ralph/active.ts`            |
| `chat-run-events:pending`                                                | derived (signal) | A random value: there may be chat run events to relay                                                                                                         | Set after a run event is recorded (`recordChatRunEvent`); compare-and-deleted by the `chat-run-events` cron after a run that left no event pending. The rebuild sets it                                                                                                                                                                                                                      | `lib/chat/pending-run-events.ts` |
| `agents-live-online`                                                     | derived          | Set of the agents announced online (`live_online`)                                                                                                            | The heartbeat adds its agent after `markAgentLiveOnline` (even when it was already online); the liveness sweep removes the agents it announces offline and those Postgres no longer has online. Rebuilt from `live_online`                                                                                                                                                                   | `lib/agents/liveness.ts`         |
| `harness-organization:{harnessId}`                                       | own              | The harness's organization, 7-day TTL                                                                                                                         | Readers on a miss. A harness never changes organization, so there's no writer                                                                                                                                                                                                                                                                                                                | `lib/agents/organization.ts`     |
| `harness-last-seen:{harnessId}`                                          | own              | The last heartbeat (ms), 30-day TTL                                                                                                                           | Every heartbeat. Read where the UI, chat and pinning show or sort by last heartbeat (`withLastSeen`, `readHarnessLastSeen`): the later of it and the row's `last_heartbeat_at` wins                                                                                                                                                                                                          | `lib/agents/last-seen.ts`        |
| `harness-report:{harnessId}`                                             | own              | Fingerprint of the report last written to the harness row, 24h TTL                                                                                            | The heartbeat: deleted before it writes the row, set after                                                                                                                                                                                                                                                                                                                                   | `lib/agents/last-seen.ts`        |
| `heartbeat-response:{harnessId}`                                         | own              | The last Postgres-built heartbeat response, with the epoch and change counters it was built under, 1h TTL                                                     | The heartbeat's Postgres path                                                                                                                                                                                                                                                                                                                                                                | `lib/agents/heartbeat-cache.ts`  |
| `heartbeat-changes:harness:{harnessId}`, `heartbeat-changes:org:{orgId}` | own              | Change counters, 30-day TTL; created at a random value                                                                                                        | Incremented after every commit that changes a heartbeat response. Harness: config, desired version, pins and unpins, update requests, host tool paths, cancel requests, job messages to a running job. Organization: harness defaults (version, `latest` tracking, task types, concurrency, host tools), a new npm `latest`, repository disconnect and SCM connection removal (pins cascade) | `lib/agents/heartbeat-cache.ts`  |
| `harness-latest-version:{orgId}`                                         | own              | npm's `latest` for organizations that track it, rechecked against npm after 5 min                                                                             | The heartbeat                                                                                                                                                                                                                                                                                                                                                                                | `lib/agents/heartbeat-cache.ts`  |
| `rate-limit:{key}:{windowStartMs}`, `rate-limit:auth_lockout:ip:{ip}`    | own              | Rate-limit window counters and auth lockouts, expiring with their window                                                                                      | `hitRateLimit`, the auth lockout                                                                                                                                                                                                                                                                                                                                                             | `lib/rate-limit.ts`              |
| `rate-limit:postgres-fallback-at`                                        | own              | When rate limiting last fell back to Postgres                                                                                                                 | `lib/rate-limit.ts`; cleared by the prune cron once the Postgres counters are past retention                                                                                                                                                                                                                                                                                                 | `lib/rate-limit.ts`              |

What each idle request does with them:

- **Harness auth** (`requireHarness`, `requireJob`): `harness-auth:{id}`. Revocation writes
  `revoked` right after its commit, so it still takes effect on the next request.
- **Rate limits and lockouts** (`guard()`): counted in Redis with the same windows as before.
- **Claim long-poll**: each look asks `job-due:{org}` (via `harness-organization:{id}`) whether a
  job is due. Only then does it read the harness and claim from Postgres; otherwise it only
  re-checks `harness-auth:{id}` and waits 2s. A Postgres claim that finds nothing re-checks the due
  entries against Postgres and drops or corrects stale ones (`reconcileDueJobs`).
- **Heartbeat** with no running jobs and no acknowledgements: records `harness-last-seen:{id}`
  and answers from `heartbeat-response:{id}` when the epoch, both change counters and the
  harness's report (`harness-report:{id}`, plus host tools) match what the response was built
  under. `claimable` comes from `job-due:{org}`; the Ably token is minted fresh. Anything else
  (running jobs to renew, a changed report, a due job, a miss) takes the Postgres path, which
  stores a new response.
- **`expire-jobs` cron**: returns `{ expired: 0 }` while `job-queued-since` has no job older than
  24h.
- **`ralph-reconcile` cron**: returns `{ skipped: true }` while `ralph:active` is absent and
  `ralph:reconciled` is present, so it runs fully at least once a day. While ralph work exists
  (`ralph:active` set) it also skips until `ralph:backoff` is due: see _Reconcile backoff_.
- **`chat-run-events` cron**: returns `{ skipped: true }` while `chat-run-events:pending` is
  absent, before initialising the chat bot (whose state is in Postgres).
- **Announcing an agent online** (every heartbeat, `noteAgentOnline`): nothing in Postgres while
  the agent is in `agents-live-online`.
- **`agent-liveness` cron** (every minute): returns `{ offline: 0 }` without querying Postgres
  while every agent in `agents-live-online` has a last-seen younger than the online window. See
  _Agent liveness_.
- **`prune-rate-limits` cron**: prunes nothing in Postgres unless `rate-limit:postgres-fallback-at`
  says rate limiting fell back to it.

### Reconcile backoff (TOOL-276)

`hasRalphWork` is true as long as any run is unfinished, any ralph PR/MR is open or any lane's
cleanup isn't through, so a single waiting run used to make the cron do a full pass every 10
minutes, changing nothing; that alone kept Neon awake about 55% of the day. Now each pass that
leaves work behind ends by computing `ralphWorkFingerprint`: a hash of what a pass can change
(each unfinished run's status, blockers, job count and outstanding PR/MR and request jobs; its
stories' status, attempts, job and lane; the lanes' PR/MR state, cleanup and publish; the queued
and running ralph jobs), from those columns rather than `updated_at`, which a write that changes
nothing still moves. A Lua script then sets `ralph:backoff` atomically:

- **Nothing changed** (the fingerprint is the previous pass's and `ralph:active` still holds the
  value the pass read): the interval doubles, 10 → 20 → 40 → 60 minutes (the cap).
- **Anything changed** (the pass advanced a run or its stories, dispatched or canceled a job,
  opened, merged or closed a PR/MR or updated a cleanup; or a writer marked ralph work during the
  pass): back to 10 minutes.

The next pass is due at the pass's start plus the interval, less 5 minutes so an invocation a
little early on the `*/10` schedule still runs; in between, the cron returns `{ skipped: true }`
without querying Postgres. While nothing changes, it queries Postgres at most once an hour.

`markRalphActive` from outside the cron (webhooks, UI actions, job outcomes, run creation) sets a
new `ralph:active` and deletes `ralph:backoff`, so the next invocation runs and the backoff starts
again at 10 minutes. The cron's own pass runs inside `runReconcilePass` (an `AsyncLocalStorage`
context): the `advanceRun` calls it makes only `SET NX` the marker, so they neither reset the
backoff nor look like an outside change; whether the pass itself changed something is the
fingerprint's call. A lost `ralph:backoff` (a flush, a rebuild, its 24h TTL) means the next
invocation runs a pass and starts again at 10 minutes; with hot state off every invocation runs a
pass, as before. The forced full pass once a day (`ralph:reconciled`) still runs whatever the
backoff says.

### Heartbeat cache bound and drift check (TOOL-276)

A cached heartbeat response is used for up to 24 hours (`CACHED_RESPONSE_TTL_MS`, was 1 hour),
unless a change counter or the epoch changes first, so an idle harness's heartbeat reaches
Postgres at most once a day. That relies on every write that changes a heartbeat response bumping
its counter (rule 3); the epoch check already covers a bump that failed. To catch a write that
forgot to bump, the entry records when it was built (`builtAt`) and Redis keeps it 48 hours: when
a heartbeat finds it unchanged but 24 hours old, it builds the response from Postgres anyway and
`checkHeartbeatDrift` compares the cached fields with the fresh ones (no extra query). A difference
is logged as an error naming the harness, the organization and the fields (not their values); the
harness gets the fresh response either way, and it's cached as usual. `ably` and `claimable` depend
on the request and aren't cached; `desiredVersion` and `versionPolicy` are left out when the
organization tracks npm's `latest` and it moved since the response was cached (`latest` changes
without a bump). The cached auth state (`harness-auth:{id}`) likewise lives 24 hours: revocation
overwrites it, so it still takes effect on the next request.

### Rules for writers

Anything that changes state an idle path caches must keep Redis current, or idle requests act on
stale state until a TTL runs out:

1. **Write Redis after the Postgres commit**, never inside the transaction: a rolled-back
   transaction must not leave a Redis change behind, and a Redis error must not roll back the
   Postgres one.
2. **Use the module's writer function** (`syncJobsDue`, `removeJobsDue`, `renewJobsDue`,
   `skipJobAndClearDue`, `cacheHarnessRevoked`, `markRalphActive`, `markRunEventsPending`,
   `bumpHarnessHeartbeat`,
   `bumpOrganizationHeartbeat`). They go through `writeHotState`, which deletes the epoch when the
   write fails, so readers rebuild from Postgres rather than trust a key that missed the change.
3. **A new write that changes what a heartbeat returns** (the harness's config, version, pins,
   update request, host tools, cancel requests, messages for its running jobs, or an
   organization's harness defaults) **bumps a change counter**: the harness's, or the
   organization's when it affects all of its harnesses. Remember cascades: deleting a repository
   or SCM connection drops pins.
4. **A new write that changes a job's status, `available_at` or lease** updates the due set
   (`syncJobsDue`, or `syncJobsDueFromPostgres` when it doesn't have the row).
5. **A new way to create or advance a ralph run** calls `markRalphActive()` (which also resets
   the reconcile backoff, unless it runs inside the cron's `runReconcilePass`); **a new way to
   record a chat run event** calls `markRunEventsPending()`.
6. **A new derived key** registers a rebuilder with `registerHotStateRebuilder` at module import,
   and its module is added to `lib/hot-state/rebuilders.ts`.
7. **Read change counters before the Postgres reads a cached value is built from; writers bump
   after commit.** Any interleaving then gives at worst a miss, never a stale hit. For a cached
   composite value, store the epoch with it rather than registering a rebuilder.
8. **A marker an idle consumer clears** holds a fresh random value per write, and the consumer
   compare-and-deletes the value it read before checking Postgres, so a write during the check is
   never lost (`ralph:active`, `chat-run-events:pending`).

Tests prove an idle path makes no Postgres query by passing a `Proxy` around the database that
counts or throws on any query method.

### Agent liveness

Live change events (TOOL-631) added the every-minute `agent-liveness` cron
and the `live_online` flag. Both reached production with the 2.0 cutover and kept Neon awake on
their own: the sweep read `agents where live_online` every minute, TOOL-766 added a query for the
organizations with jobs waiting on host tools to every sweep, and each heartbeating agent updated
its row (a no-op) once a minute, when its 60s `agent-live:{id}` marker expired.

`agents-live-online` replaces the per-agent marker. A heartbeat checks membership and only runs
`markAgentLiveOnline` when its agent isn't in the set, then adds it. The sweep reads the set and
the agents' last-seen times: when every member is fresh, it's done; otherwise it reads the
online agents from Postgres (the row's `last_heartbeat_at` still counts, for a heartbeat that
missed Redis), announces the stale ones offline and removes from the set every candidate that
isn't still online. With hot state off, or while the epoch is being rebuilt, it reads Postgres
as before.

The sweep no longer refreshes every organization's host tool waits. The waits change only with
the agents that count for them and the jobs that need them, so each of those writes refreshes the
organization's waits itself: an enqueue or a target change, a retried job (`failJob`), an agent
announced online or offline, a host tool report, a deletion, a revocation and a refresh-token
reuse (which revokes). Each refreshes in the same transaction as its write, since nothing sweeps
the waits any more: a refresh that fails rolls the write back, and whatever made it retries (the
next liveness sweep still finds the agent online, the next heartbeat still sees the changed
report, the agent retries its `fail`).

### The epoch rebuild

`hot-state:epoch` has no TTL. When it's missing (a new Redis, a flush, an eviction, or a writer
whose Redis update failed), the next `readHotState` call:

1. takes `hot-state:rebuild-lock` (`SET NX PX 30s` with a random token);
2. runs every registered rebuilder: `job-due` deletes every `job-due:*` and `job-queued-since` and
   reloads them from the queued and running jobs; `harness-auth` deletes every `harness-auth:*`
   (they refill on the next miss); `agent-liveness` reloads `agents-live-online` from
   `live_online`; `ralph-active` sets `ralph:active` (and deletes `ralph:backoff`) and `chat-run-events-pending` sets
   `chat-run-events:pending`;
3. sets the epoch and releases the lock (compare-and-delete on its token).

Readers on other instances that find the lock taken read Postgres meanwhile. A failing rebuilder
leaves the epoch unset, so the next read retries. Rebuilders are idempotent and register at module
import; because Next bundles each route separately, every `readHotState` caller imports
`lib/hot-state/rebuilders.ts`, so whichever route notices the missing epoch runs all of them.

A writer that commits while a rebuild is reading Postgres can have its Redis update overwritten by
the rebuild's older snapshot. Each derived key tolerates that: a stale due entry costs one Postgres
claim, which then corrects it (`reconcileDueJobs`, and `reconcileExpiredQueuedJobs` for the expire
cron); `harness-auth` entries are deleted rather than reloaded; `ralph:active` and
`chat-run-events:pending` are set, never cleared, by the rebuild. Cached heartbeat responses carry the epoch value they were built under, so
a rebuild invalidates all of them.

### The fallback

- **`REDIS_URL` unset** (local development, tests that don't need Redis, a deployment without
  Upstash): `hotStateEnabled()` is false and every path runs its Postgres code as before this ADR.
- **Redis unreachable or erroring**: commands fail within about 2s; `readHotState` logs and runs
  `fromPostgres`, and the own-key paths catch and use Postgres (rate limits count there, the
  heartbeat writes the harness row and builds its response, the claim and the crons query as they
  used to). The checks that gate Postgres work (`hasDueJob`, `hasExpiredQueuedJob`,
  `checkRalphReconcile`, `checkPendingRunEvents`) answer "maybe" so no work is skipped. Rate limiting remembers that it
  fell back so the prune cron cleans up the Postgres counters later.
- **Redis lost or flushed**: the epoch rebuild restores derived keys; own keys start over (rate
  limit windows reset, the next heartbeat writes the row and misses the cache).

Behaviour stays correct in each case; only Neon's idle time is lost.

### Why TCP and not REST

Upstash offers both a Redis protocol endpoint (TCP with TLS, `rediss://`) and an HTTP REST API. We
use `ioredis` over TCP:

- **Cost.** Every outbound HTTP call from a Vercel function is an Observability Plus external API
  event. The idle paths make several Redis calls per heartbeat and claim look, for every harness,
  which would add back the per-request cost [ADR 0006](0006-postgres-job-queue.md) removed. TCP
  connections aren't counted.
- **Latency and features.** One connection per instance, reused across requests (Fluid compute
  serves many requests per instance), with pipelines, `MULTI` and Lua scripts in one round trip.
- `REDIS_URL` is the TCP URL (`rediss://default:<password>@<host>:6379`), not the REST URL and
  token.

### Postgres paths that still run while idle

With every harness idle and no UI or webhook traffic, these still query Postgres:

- **Token refresh** (`/api/agent/token`): each harness refreshes its one-day access token about
  once a day, which reads and rotates its refresh token in Postgres ([ADR 0002](0002-agent-auth.md),
  TOOL-276; it was every ~12 minutes with 15-minute tokens).
- **Cache expiry**, rare per harness: a heartbeat whose cached response is a day old (with the
  drift check), a harness row write once a day (`harness-report:{id}` expires),
  `harness-auth:{id}` refilled once a day,
  `harness-organization:{id}` once a week.
- **`ralph-reconcile` while ralph work exists**: a pass at most once an hour while nothing
  changes (every 10 minutes after a change).
- **Daily crons**: the forced `ralph-reconcile` run, `prune-webhook-deliveries`,
  `prune-hidden-refs`, `gitlab-maintenance`.
- **Anything after a change**: a counter bump, a due job (including a lapsed lease), an epoch
  rebuild, or a Redis outage sends the next idle request down the Postgres path once.

Real work still uses Postgres directly: dispatching, claiming and running jobs (heartbeats with
running jobs renew leases there), the UI, webhooks and chat.

## Alternatives considered

- **Postgres `LISTEN/NOTIFY` or a smaller always-on database.** Either keeps a Postgres compute
  awake, which is the cost we're removing.
- **Upstash REST (`@upstash/redis`).** Built for serverless, but each call is an external API event
  (see above).
- **Vercel Edge Config or KV-style caches.** Edge Config is read-optimised with slow writes, not
  suited to counters and per-heartbeat updates.
- **In-process caches.** Instances don't share them, so a revocation or dispatch on one instance
  wouldn't reach requests on another; we'd need cross-instance invalidation, which is what Redis
  provides.
- **Longer intervals** (heartbeat, long-poll, crons). Cuts queries proportionally but never to
  zero, and delays job pickup and revocation.

## Breaking points: revisit this decision when

1. **Token refresh keeps Neon awake** even at once a day per harness: move refresh-token
   rotation off the idle path.
2. **A writer misses Redis.** Idle requests acting on stale state (a job not picked up within a
   few seconds, a configuration change taking up to a day, a heartbeat cache drift error) means a
   write path doesn't follow the rules above; fix the writer rather than shorten TTLs.
3. **Redis cost or limits.** Command counts grow with harnesses × requests; past Upstash's plan
   limits, reconsider the heartbeat interval or batch more commands per request.
4. **Redis as the source of truth.** If something would only live in Redis and couldn't be rebuilt
   or safely lost, it needs a persistence and recovery story of its own; that isn't this ADR.

## Consequences

- With Redis configured and harnesses idle, heartbeats, claims, revocation checks, rate limits and
  the `expire-jobs`, `ralph-reconcile` and `chat-run-events` crons make no Postgres queries.
- Job pickup stays within the claim's 2s look plus a round trip, and revocation takes effect on the
  next request.
- Every write path that changes cached state must call the matching Redis writer after its commit:
  a missed one shows up as stale idle behaviour bounded by the key's TTL, not as wrong Postgres
  data.
- Redis is optional: without `REDIS_URL` the control panel behaves as before, at the old Postgres
  cost.
- One more service to provision and monitor ([deploy-control-panel.md](../deploy-control-panel.md#redis-upstash)).
