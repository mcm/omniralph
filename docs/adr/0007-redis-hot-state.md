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

| Key                                                                      | Kind             | Holds                                                                                                                                                     | Written by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Module                           |
| ------------------------------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `hot-state:epoch`                                                        | control          | When the derived keys were last rebuilt; no TTL                                                                                                           | The rebuild; deleted by a failed `writeHotState`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `lib/hot-state/epoch.ts`         |
| `hot-state:rebuild-lock`                                                 | control          | The rebuilding instance's token (`SET NX PX 30s`)                                                                                                         | The rebuild                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `lib/hot-state/epoch.ts`         |
| `harness-auth:{harnessId}`                                               | derived          | `active` or `revoked`, until the next daily window                                                                                                        | Readers on a miss (`SET NX`); `revoked` after `revokeHarness` and after refresh-token reuse (token route). Rebuild deletes them all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `lib/harness-auth/auth-state.ts` |
| `job-due:{organizationId}`                                               | derived          | Sorted set of queued and running jobs, scored by when each can next be claimed (`available_at`, or `lease_expires_at`)                                    | After every commit that changes a job's status, availability or lease: dispatch and cancel (dispatcher), claim, lease renewal (heartbeat), retry and fail, result, skip, revoke (requeue), expire, review correlation. Rebuilt from the queued and running jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `lib/dispatch/due.ts`            |
| `job-queued-since`                                                       | derived          | Sorted set of every queued job, scored by `created_at`                                                                                                    | The same writers as `job-due:*` (`syncJobsDue`); rebuilt with it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `lib/dispatch/due.ts`            |
| `ralph:due`                                                              | derived          | Sorted set of the ralph work the reconcile cron checks next, scored by when it's due (ms): `run:<id>` advances a run, `lane:<id>` checks a lane's cleanup | `advanceRun` (a safety check at +10 min before it starts, then its result: nothing for a job in flight, +1 h waiting, removed when finished or gone, +`RECONCILE_STALE_MS` pending or running without a job); run creation (`start.ts`, `chat-start.ts`, the safety check before the commit); a ralph job's result, failure or cancel (the safety check before the commit; a cleanup job's lane too, replaced once its outcome is applied: +1 h failed, the kept-branch question's deadline, else removed); recording a PR/MR closed or merged (the lane's safety check, replaced once its cleanup started). Rebuilt with every unfinished run due now, every failed or pending cleanup now and every kept-branch question at its deadline | `lib/ralph/due.ts`               |
| `agent-refresh:tokens`                                                   | derived          | Hash of each agent's current signed refresh token: `<generation>:<hash of its random ID>`                                                                 | The token route (one script: compare, advance, buffer the audit row), enrollment and legacy-token redemption (after the commit). Rebuilt from `agents.refresh_generation`, never lowering a newer generation Redis holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `lib/agent-auth/refresh.ts`      |
| `agent-refresh:audit`                                                    | own              | List of buffered `token_refresh` audit rows (JSON)                                                                                                        | The token route; drained by the `flush-agent-auth` cron after each insert. Lost with Redis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `lib/agent-auth/refresh.ts`      |
| `agent-refresh:changed`                                                  | own              | Set of the agents whose token in `agent-refresh:tokens` is newer than Postgres's                                                                          | The token route (the same script); unmarked by the `flush-agent-auth` cron once their token is written, unless it changed meanwhile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `lib/agent-auth/refresh.ts`      |
| `agent-refresh:flush-lock`                                               | control          | The running flush's token (`SET NX PX 15m`)                                                                                                               | The `flush-agent-auth` cron                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `lib/agent-auth/refresh.ts`      |
| `ralph:reconciled`                                                       | own              | The daily window of the last full pass                                                                                                                    | The reconcile cron                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `lib/ralph/due.ts`               |
| `chat-run-events:pending`                                                | derived (signal) | A random value: there may be chat run events to relay                                                                                                     | Set after a run event is recorded (`recordChatRunEvent`); compare-and-deleted by the `chat-run-events` cron after a run that left no event pending. The rebuild sets it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `lib/chat/pending-run-events.ts` |
| `agents-live-online`                                                     | derived          | Set of the agents announced online (`live_online`)                                                                                                        | The heartbeat adds its agent after `markAgentLiveOnline` (even when it was already online); the liveness sweep removes the agents it announces offline and those Postgres no longer has online. Rebuilt from `live_online`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `lib/agents/liveness.ts`         |
| `harness-organization:{harnessId}`                                       | own              | The harness's organization, 7-day TTL                                                                                                                     | Readers on a miss. A harness never changes organization, so there's no writer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `lib/agents/organization.ts`     |
| `harness-last-seen:{harnessId}`                                          | own              | The last heartbeat (ms), 30-day TTL                                                                                                                       | Every heartbeat. Read where the UI, chat and pinning show or sort by last heartbeat (`withLastSeen`, `readHarnessLastSeen`): the later of it and the row's `last_heartbeat_at` wins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `lib/agents/last-seen.ts`        |
| `harness-report:{harnessId}`                                             | own              | Fingerprint of the report last written to the harness row, until the next daily window                                                                    | The heartbeat: deleted before it writes the row, set after                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `lib/agents/last-seen.ts`        |
| `heartbeat-response:{harnessId}`                                         | own              | The last Postgres-built heartbeat response, with the epoch and change counters it was built under, 48h TTL                                                | The heartbeat's Postgres path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `lib/agents/heartbeat-cache.ts`  |
| `heartbeat-changes:harness:{harnessId}`, `heartbeat-changes:org:{orgId}` | own              | Change counters, 30-day TTL; created at a random value                                                                                                    | Incremented after every commit that changes a heartbeat response. Harness: config, desired version, pins and unpins, update requests, host tool paths, cancel requests, job messages to a running job. Organization: harness defaults (version, `latest` tracking, task types, concurrency, host tools), a new npm `latest`, repository disconnect and SCM connection removal (pins cascade)                                                                                                                                                                                                                                                                                                                                               | `lib/agents/heartbeat-cache.ts`  |
| `harness-latest-version:{orgId}`                                         | own              | npm's `latest` for organizations that track it, rechecked against npm after 5 min                                                                         | The heartbeat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `lib/agents/heartbeat-cache.ts`  |
| `rate-limit:{key}:{windowStartMs}`, `rate-limit:auth_lockout:ip:{ip}`    | own              | Rate-limit window counters and auth lockouts, expiring with their window                                                                                  | `hitRateLimit`, the auth lockout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `lib/rate-limit.ts`              |
| `rate-limit:postgres-fallback-at`                                        | own              | When rate limiting last fell back to Postgres                                                                                                             | `lib/rate-limit.ts`; cleared by the prune cron once the Postgres counters are past retention                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `lib/rate-limit.ts`              |

What each idle request does with them:

- **Harness auth** (`requireHarness`, `requireJob`): `harness-auth:{id}`. Revocation writes
  `revoked` right after its commit, so it still takes effect on the next request.
- **Rate limits and lockouts** (`guard()`): counted in Redis with the same windows as before.
- **Token refresh** (`/api/agent/token`, every ~12 minutes per agent): `agent-refresh:tokens`
  and `harness-auth:{id}`; see _Write-free token refresh_. Only reuse writes to Postgres.
- **`flush-agent-auth` cron** (daily window): writes the `agent-refresh:tokens` of the agents in
  `agent-refresh:changed` to `agents.refresh_generation` and drains `agent-refresh:audit` into
  `agent_audit`; with neither, it makes no Postgres query.
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
- **`ralph-reconcile` cron**: returns `{ skipped: true }` while no `ralph:due` entry is due and
  `ralph:reconciled` records the current daily window, so it runs the full pass once a day: see
  _Reconcile schedule_ and _Daily window_.
- **`chat-run-events` cron**: returns `{ skipped: true }` while `chat-run-events:pending` is
  absent, before initialising the chat bot (whose state is in Postgres).
- **Announcing an agent online** (every heartbeat, `noteAgentOnline`): nothing in Postgres while
  the agent is in `agents-live-online`.
- **`agent-liveness` cron** (every minute): returns `{ offline: 0 }` without querying Postgres
  while every agent in `agents-live-online` has a last-seen younger than the online window. See
  _Agent liveness_.
- **`prune-rate-limits` cron**: prunes nothing in Postgres unless `rate-limit:postgres-fallback-at`
  says rate limiting fell back to it.

### Reconcile schedule (TOOL-853, TOOL-854)

The reconcile cron used to poll: a marker (`ralph:active`) set after every `advanceRun` and a
backoff (`ralph:backoff`, from every 10 minutes up to every hour while a fingerprint of the ralph
work stayed unchanged) kept it querying Postgres as long as any ralph work existed, and every
advance with a job in flight reset it to 10 minutes. Now `ralph:due` says when each run is due,
and the cron touches Postgres only for runs that are.

`ralph:due` is a sorted set: members `run:<id>` and `lane:<id>`, scored by due time (ms). The cron reads
`ZRANGEBYSCORE ralph:due -inf <now>`; with nothing due and the full pass done for the current daily window it returns
`{ skipped: true }`. Otherwise it advances only the due runs, organization by organization (with
the organization's Linear gateway, or a disconnected one for the chat runs of an organization
without Linear; a Linear run of an organization that disconnected Linear leaves the schedule, as
the full pass skips it too). A run that's gone leaves the schedule. Each advance reschedules its
run from the result:

| Result                                                                                   | Schedule                                |
| ---------------------------------------------------------------------------------------- | --------------------------------------- |
| A job in flight (`busy`, `enqueued`, `pushing`, `describing`, `preparing`, `requesting`) | Removed: the job's outcome is the event |
| `waiting` on a blocker or a person                                                       | +1 h, for a missed webhook              |
| Finished (`finished`, `completed`, `failed`) or `gone`                                   | Removed                                 |
| `waiting` with the run still pending or running, no job                                  | +`RECONCILE_STALE_MS` (10 minutes)      |

A due lane gets its cleanup checked (`reconcileLane`: a cleanup job's outcome that was never
applied, a merged or closed lane whose cleanup never started, a failed one, a kept branch whose
question timed out), then is rescheduled from what's left; what's still due right away (a
deletion it couldn't start) is tried again in an hour:

| Lane                                                       | Schedule                                    |
| ---------------------------------------------------------- | ------------------------------------------- |
| A cleanup job in flight, or a cleanup pending on a run job | Removed: the job's outcome is the event     |
| Failed cleanup                                             | +1 h                                        |
| Kept-branch question                                       | Its deadline                                |
| Open PR/MR, done cleanup, stash questions only             | Removed: webhooks, plus the daily full pass |

A due run also starts its lanes' pending cleanups once its jobs are through, for an outcome hook
that never ran.

**Crash safety.** A `finally` doesn't run when Vercel kills the function, so a write that leaves
follow-up work schedules a safety check (+10 minutes) _before_ it commits: `advanceRun` before it
starts, run creation (`start.ts`, `chat-start.ts`) inside its transaction, a ralph job's result,
failure or cancel (`scheduleJobOutcomeCheck`, plus `lane:<id>` for a cleanup job) before the job's
row changes, recording a PR/MR closed or merged (`recordClosedPullRequest`, `lane:<id>`) before
the write. The handler that does
the follow-up replaces it (`advanceRun` from its result; `catchUpRun` removes it for a finished
run). A throw leaves it, so a failed advance is retried about 10 minutes later; a commit that
fails afterwards costs one spurious check. This is the one exception to rule 1: an entry that only
schedules a check can't do harm when the transaction rolls back.

The full pass still runs once a day, in the daily window (see _Daily window_): every
organization's waiting and stale runs, cleanup and CI. The runs it advanced are rescheduled, so it then advances only
the runs and lanes still due. A flushed Redis is rebuilt with every unfinished run due now, every
failed or pending cleanup now and every kept-branch question at its deadline (`ralph-due`);
with hot state off or Redis down, every invocation runs the full pass.

### Daily window (TOOL-855)

Every daily task that queries Postgres runs in one window starting at 03:15 UTC
(`lib/daily-window.ts`: `dailyWindowStart(day)`, `currentDailyWindow(now)`,
`nextDailyWindow(now)`), so an idle day wakes Neon once instead of at scattered times. The daily
crons (`flush-agent-auth`, `gitlab-maintenance`, `model-prices`, `prune-hidden-refs`,
`prune-inbox-states`, `prune-webhook-deliveries`) are all scheduled at `15 3 * * *` and run in
parallel: they touch separate tables.

The reconcile cron's full pass used to run whenever `ralph:reconciled` (24h TTL) expired, a time
of day that drifted with when the key was first set. Now `ralph:reconciled` records the start
(ms) of the window its last full pass ran for, without a TTL: the first invocation at or after a
window's start (03:20 UTC, on the `*/10` schedule) finds an older window and does the pass. If
that invocation didn't run, the next one does. Between windows the cron runs only the due
`ralph:due` entries. A lost key (a flush) makes the next invocation do the pass, which records the
current window, so the next pass is still at the next window.

A cached heartbeat response is due at the first heartbeat after the next window start too (see
_Heartbeat cache bound and drift check_), so idle harnesses reach Postgres in the same window.
So are the cached auth state (`harness-auth:{id}`) and the report fingerprint
(`harness-report:{id}`, TOOL-912): both expire at the next window start
(`msUntilNextDailyWindow`), so the auth state's Postgres read and the harness row's write happen
in the window. They used to live 24 hours, a time of day that drifted with when each was set.

### Write-free token refresh (TOOL-856)

A refresh used to rotate the refresh token in Postgres and write a `token_refresh` audit row.
Refresh tokens are now signed (see [ADR 0002](0002-agent-auth.md)) and carry the agent ID, a
generation and a random ID; `agent-refresh:tokens` holds each agent's current generation and the
hash of its random ID. One Lua script compares the presented token with it, records the next token
and buffers the audit row in `agent-refresh:audit`, so a refresh reads only Redis (plus the cached
auth state and rate limits) and writes nothing to Postgres. The script also adds the agent to
`agent-refresh:changed`. The `flush-agent-auth` cron, in the daily window, writes the changed
agents' generations (only forward) and the buffered rows to Postgres, then unmarks each agent
whose token is still the one it wrote; with nothing changed and nothing buffered it makes no
Postgres query. It holds `agent-refresh:flush-lock` while it runs, so a cron event delivered twice
doesn't write the rows twice or trim rows nobody wrote.

- **Rebuild.** The rebuilder merges `agents.refresh_generation` in without lowering a newer
  generation Redis holds: a rebuild forced by another writer's failure keeps today's generations,
  so older tokens stay reuse. After Redis loses its state, its generations are the last flush's: a
  newer one presented is accepted once and Redis catches up (see ADR 0002).
- **Fallback.** With hot state off, while another instance rebuilds, or when Redis errors, the
  refresh rotates in Postgres (`rotateSignedRefreshToken`, the same comparison) and writes its
  audit row there. A Redis error also deletes the epoch, since the script may have run.
- **Loss.** Audit rows buffered since the last flush are lost with Redis's state.

### Heartbeat cache bound and drift check (TOOL-276, TOOL-857)

A cached heartbeat response is used until the next daily window (see _Daily window_) after it
was built, unless a change counter or the epoch changes first, so an idle harness's heartbeat
reaches Postgres once a day, in the window Neon is awake for anyway. It used to be due 24 hours
after its build (`CACHED_RESPONSE_TTL_MS`), a time of day that drifted with when each harness
started. That relies on every write that changes a heartbeat response bumping its counter
(rule 3); the epoch check already covers a bump that failed. To catch a write that forgot to
bump, the entry records when it was built (`builtAt`) and Redis keeps it 48 hours: when a
heartbeat finds it unchanged but past `cachedResponseDueAt(builtAt)` (the first window start after
`builtAt`), it builds the response from Postgres anyway and `checkHeartbeatDrift` compares the
cached fields with the fresh ones (no extra query). A due response is compared even when the
report's fingerprint (`harness-report:{id}`) expired, as it does at the same window start: the
response is keyed by the report anyway, and the Postgres path writes the row. A difference is logged as an error naming the
harness, the organization and the fields (not their values); the harness gets the fresh response
either way, and it's cached as usual. `ably` and `claimable` depend on the request and aren't
cached; `desiredVersion` and `versionPolicy` are left out when the organization tracks npm's
`latest` and it moved since the response was cached (`latest` changes without a bump). The cached
auth state (`harness-auth:{id}`) likewise lives until the next window: revocation overwrites it,
so it still takes effect on the next request.

### Rules for writers

Anything that changes state an idle path caches must keep Redis current, or idle requests act on
stale state until a TTL runs out:

1. **Write Redis after the Postgres commit**, never inside the transaction: a rolled-back
   transaction must not leave a Redis change behind, and a Redis error must not roll back the
   Postgres one. The exception is a `ralph:due` safety check, written before the commit (see
   _Reconcile schedule_).
2. **Use the module's writer function** (`syncJobsDue`, `removeJobsDue`, `renewJobsDue`,
   `skipJobAndClearDue`, `cacheHarnessRevoked`, `scheduleRun`, `markRunEventsPending`,
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
5. **A new way to create a ralph run** schedules its safety check (`scheduleRunSafetyCheck`)
   before the commit, then advances it (`advanceRun`, which schedules it) or schedules it by its
   status (`scheduleRunByStatus`); **a new way to finish a ralph job** calls
   `scheduleJobOutcomeCheck` before the commit; **a new way to record a chat run event** calls
   `markRunEventsPending()`.
6. **A new derived key** registers a rebuilder with `registerHotStateRebuilder` at module import,
   and its module is added to `lib/hot-state/rebuilders.ts`.
7. **Read change counters before the Postgres reads a cached value is built from; writers bump
   after commit.** Any interleaving then gives at worst a miss, never a stale hit. For a cached
   composite value, store the epoch with it rather than registering a rebuilder.
8. **A marker an idle consumer clears** holds a fresh random value per write, and the consumer
   compare-and-deletes the value it read before checking Postgres, so a write during the check is
   never lost (`chat-run-events:pending`).

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
   `live_online`; `ralph-due` replaces `ralph:due` with every unfinished run and failed or pending cleanup due now
   and every kept-branch question at its deadline, and `chat-run-events-pending` sets
   `chat-run-events:pending`;
3. sets the epoch and releases the lock (compare-and-delete on its token).

Readers on other instances that find the lock taken read Postgres meanwhile. A failing rebuilder
leaves the epoch unset, so the next read retries. Rebuilders are idempotent and register at module
import; because Next bundles each route separately, every `readHotState` caller imports
`lib/hot-state/rebuilders.ts`, so whichever route notices the missing epoch runs all of them.

A writer that commits while a rebuild is reading Postgres can have its Redis update overwritten by
the rebuild's older snapshot. Each derived key tolerates that: a stale due entry costs one Postgres
claim, which then corrects it (`reconcileDueJobs`, and `reconcileExpiredQueuedJobs` for the expire
cron); `harness-auth` entries are deleted rather than reloaded; a run or lane missing from `ralph:due` is still
handled by the next job outcome, webhook or daily full pass; `chat-run-events:pending` is set,
never cleared, by the rebuild. Cached heartbeat responses carry the epoch value they were built under, so
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

- **Cache expiry**, rare per harness: a heartbeat whose cached response is due (with the
  drift check), a harness row write (`harness-report:{id}` expires) and `harness-auth:{id}`
  refilled, all once a day in the daily window,
  `harness-organization:{id}` once a week.
- **`ralph-reconcile` while ralph work exists**: a pass at most once an hour while nothing
  changes (every 10 minutes after a change).
- **Daily crons**: the forced `ralph-reconcile` run, `prune-webhook-deliveries`,
  `prune-hidden-refs`, `gitlab-maintenance`, `flush-agent-auth`.
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

1. **Token refresh keeps Neon awake.** Rotation is off the idle path (_Write-free token
   refresh_); if refreshes fall back to Postgres often (Redis errors, rebuilds), the fallback
   rather than the flush is what wakes Neon.
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
