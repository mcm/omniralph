# ADR 0009: Ably wake signals replace the claim long-poll

- **Status:** Accepted (TOOL-491). Supersedes the long-poll of
  [ADR 0006](0006-postgres-job-queue.md#the-long-poll) when `ABLY_API_KEY` is set.
- **Date:** 2026-10-15

## Context

[ADR 0006](0006-postgres-job-queue.md) made idle harnesses hold one `POST /api/harness/claim` open
for up to 50s (`MAX_CLAIM_WAIT_SECONDS`) and open the next one as soon as it returns. It expected
held requests to be cheap because they share a Fluid compute instance, and named the cost of held
requests as breaking point 2.

That breaking point was reached. Fluid compute bills provisioned memory for the whole hold, and the
held claims became the largest Vercel cost: 88 GB-hours of fluid memory per 12 hours (about
$56/month), of which roughly 64 GB-hours were held claims (the rest is the Discord gateway cron of
[ADR 0005](0005-chat-front-door.md)). Each idle harness also sent about 1,700 claim requests a day,
and each fed observability events (about 100k a day in total), almost all of them empty claims.

A harness only needs to claim when there may be something to claim: when a job was dispatched, a
delayed retry became due or a lease lapsed. The control panel knows about the first as it happens;
the others it can answer on the heartbeat harnesses already send every 20s.

## Decision

**When a job is dispatched, the control panel publishes an empty wake message on Ably, and the
harness claims once without waiting. The heartbeat delivers the harness's Ably token and a
`claimable` flag that covers everything a wake can't. Without `ABLY_API_KEY` everything behaves as
in ADR 0006.**

### Channels and the wake message

Two channels per harness, named by `harnessWakeChannel` and `orgWakeChannel` in `packages/shared`
so both sides use the same names:

| Channel                | Woken for                                                  |
| ---------------------- | ---------------------------------------------------------- |
| `harness:<harnessId>`  | Jobs targeted at this harness (`target_harness_id`)        |
| `org:<organizationId>` | Untargeted jobs: any harness of the organization may claim |

A wake is a message named `wake` with no data. It carries no job, pool or task type: the claim
decides what the harness gets, so a wake can never hand out something the claim wouldn't, and Ably
never sees job data.

### Publishing

Only the control panel publishes, through Ably's REST API (`POST
https://rest.ably.io/channels/<channel>/messages`, Basic auth with `ABLY_API_KEY`, 5s timeout).
`AblyRestWakePublisher` (`apps/web/src/lib/ably/publisher.ts`) does it; `getWakePublisher()`
returns null without the key. `PostgresDispatcher` (`apps/web/src/lib/dispatch/dispatcher.ts`)
wakes:

- after `createAndPublish` inserts a job (or finds its deduplicated twin): the target harness's
  channel if the job has one, else the organization's;
- after `republish` re-resolves a queued job's target: the new target's channel.

Publishing is best effort: a failed publish is logged and never thrown, so dispatch can't fail
because of Ably. A wake that arrives before the job's transaction commits costs one empty claim;
the heartbeat's `claimable` flag picks the job up later.

### Tokens

Harnesses never hold the API key. The control panel signs each harness a JWT
(`apps/web/src/lib/ably/token.ts`, `signAblyToken`) locally with `jose`, using the key secret:

| Field               | Value                                                        |
| ------------------- | ------------------------------------------------------------ |
| Header `alg`, `kid` | `HS256`, the key name (`ABLY_API_KEY` before the `:`)        |
| `iat`, `exp`        | Now, now + 12h (`ABLY_TOKEN_TTL_SECONDS`)                    |
| `x-ably-clientId`   | The harness ID                                               |
| `x-ably-capability` | `{"harness:<id>":["subscribe"],"org:<orgId>":["subscribe"]}` |

Issuing makes no Ably call. It can't go through KMS like the other control-panel signatures
(`apps/web/src/lib/agent-auth/signer.ts`): Ably only accepts tokens signed with the key secret.
The token can only subscribe to the harness's own two channels, so a leaked token reveals when jobs
are dispatched to that harness or its organization, nothing more. `getAblyConfig()` returns null
(Ably off) when the key is unset or malformed; a malformed key is logged.

### Token delivery on the heartbeat

No new harness-to-control-panel request: the token rides on the heartbeat.

- `Heartbeat.ablyTokenExpiresAt` (optional ISO time): the expiry of the token the harness holds,
  absent when it has none.
- `HeartbeatResponse.ably` (optional, nullable): `{ token, expiresAt }` when Ably is configured and
  the harness's token is missing or expires within 1 hour (`ABLY_TOKEN_RENEW_BEFORE_MS`); `null`
  when Ably isn't configured; absent otherwise (keep the current token).

The harness keeps the latest token and hands it to the Ably SDK from its `authCallback`
(`apps/agent/src/wake.ts`), so the SDK's own reauthentication picks up renewed tokens.

### The `claimable` flag

The heartbeat request gains optional `claimablePools`: the harness's `claimablePools()` (the pools
under their limits), sent only in wake mode and while a slot is free. When present, the response's
`claimable` says whether a claim for those pools would find a job right now (`heartbeatClaimable`,
`apps/web/src/lib/agent-api/claimable.ts`, calling `hasClaimableJob`).

`claimJob` and `hasClaimableJob` (`packages/db/src/jobs.ts`) share one query builder for the
candidate conditions (organization, pool or `system`, target, queued and available or a lapsed
lease, minimum harness version, installables, host tools), so the flag and the claim can't drift.
`hasClaimableJob` also counts cancel-requested and out-of-deliveries candidates, which the claim
then settles, so `claimable: true` can be followed by a 204; the harness doesn't loop on it.

The flag covers everything no wake is sent for: delayed retries becoming due, lapsed leases, wakes
lost or published before the commit, and the time the harness's Ably connection is down. A job is
picked up within one heartbeat (≤20s) in all of those cases.

### Harness modes

The daemon (`apps/agent/src/daemon.ts`, `claimLoop`) runs in one of two modes:

- **Long-poll mode** (no Ably token): exactly ADR 0006's long-poll. The harness starts in it and
  stays in it without `ABLY_API_KEY`, against a control panel too old to send `ably`, or when the
  wake subscription can't be opened.
- **Wake mode** (holding a token from a heartbeat): the harness subscribes to its two channels
  (`createWakeSubscription`, `apps/agent/src/wake.ts`) and claims with `waitSeconds: 0`, never
  holding a request. Entering wake mode aborts an in-flight long-poll.

In wake mode a claim is triggered by:

| Trigger                                           | Counts while Ably is disconnected |
| ------------------------------------------------- | --------------------------------- |
| A wake message                                    | (none arrive)                     |
| The Ably connection (re)connecting, incl. startup | no                                |
| A heartbeat answering `claimable: true`           | yes                               |
| A job ending (a slot frees)                       | no                                |
| The claimable pools changing                      | no                                |

Triggers coalesce: any number of them during a claim cause one more claim after it, and triggers
are dropped while no slot is free (a job ending re-triggers). After a claim returns a job (or a
skip) the harness claims again at once while a slot is free; after an API error it claims again
after the usual back-off (1s doubling to 30s). While the Ably connection is down the harness does
not long-poll: only the heartbeat flag triggers claims, so a disconnected harness costs one
heartbeat every 20s, as before.

Draining closes the subscription and resuming reopens it; a change of organization recreates it.
A heartbeat answering `ably: null` drops the token and returns the harness to long-poll mode, so
removing `ABLY_API_KEY` takes effect within one heartbeat.

### Compatibility

Every new protocol field is optional, and `HeartbeatResponse` still parses responses without them.

| Control panel               | Harness | Behavior                                  |
| --------------------------- | ------- | ----------------------------------------- |
| Old, or new without the key | Any     | Long-poll (ADR 0006)                      |
| New, with `ABLY_API_KEY`    | Old     | Ignores `ably` and `claimable`; long-poll |
| New, with `ABLY_API_KEY`    | New     | Wake mode                                 |

The long-poll path (`waitSeconds`, `MAX_CLAIM_WAIT_SECONDS`, the claim route's retry loop) stays as
the fallback.

### Cutover

A person does this after the merge:

1. Create an Ably app on the free plan, and an API key with the **publish** and **subscribe**
   capabilities (Ably dashboard › your app › **API Keys**).
2. Set `ABLY_API_KEY` (`<keyName>:<keySecret>`) in the Vercel project ([env.md](../env.md)) and
   deploy the control panel. Dispatches now publish wakes and heartbeats hand out tokens; harnesses
   on older versions keep long-polling.
3. Raise `desiredVersion` (Settings › Harnesses) so harnesses update themselves. Each enters wake
   mode on its first heartbeat after the update (its log says `claiming on Ably wake signals`).
4. Make sure each harness host allows outbound WebSocket connections to Ably
   ([deploy-harness.md](../deploy-harness.md)); a harness that can't connect still picks jobs up
   through the heartbeat flag, within 20s.

To roll back, remove `ABLY_API_KEY` and redeploy: the next heartbeat answers `ably: null` and every
harness returns to the long-poll.

## Alternatives considered

- **Pusher Channels.** The same model (server publishes, clients subscribe to private channels),
  but its free Sandbox plan allows 100 connections and 200k messages a day, and private channels
  need an auth endpoint the harness would call (a new request) instead of a self-contained token we
  can hand out on the heartbeat. Ably's JWTs are signed locally with no Ably call and scoped by
  capability, and its free plan is larger.
- **Shorter polling.** Plain claims every few seconds hold nothing, but trade memory time for
  invocations: at a 5s interval an idle harness sends about 17,000 claims a day (the ADR 0001
  problem again), and every job still waits up to the interval. Polling only on the heartbeat (20s)
  costs nothing new but delays every job by up to 20s; it's what the `claimable` flag gives us as
  the fallback.
- **Outbound webhooks to harnesses.** The control panel would call the harness directly. Harnesses
  open no inbound port (they run behind NAT on workspaces), so this would need a tunnel or relay per
  harness. A later wake transport could still be added behind the same wake publisher interface.
- **Redis or Postgres `LISTEN/NOTIFY` to wake held claims** (ADR 0006's suggestion). Cuts the
  database polling of held claims but still holds the request, which is the cost being removed.

## Breaking points: revisit this decision when

1. **Ably free-plan limits.** 200 concurrent connections (one per harness), 500 messages per second
   and 6M messages a month. A dispatch publishes one wake, and each wake is delivered to every
   subscriber of its channel (an organization-wide wake counts once per harness of the
   organization). Approaching 200 harnesses, or messages approaching a few million a month, means
   moving to a paid plan or another transport.
2. **Wake storms.** An organization with many harnesses gets one claim from each of them per
   untargeted job. If those empty claims add up, wake a subset of harnesses or target jobs earlier.
3. **Heartbeat load.** The `claimable` check adds a query to wake-mode heartbeats with a free slot.
   If heartbeats show up in Neon's metrics, move the check (and the heartbeat) off Postgres
   (a separate Redis issue).
4. **Token revocation.** A revoked harness keeps its token until it expires (≤12h) and can still
   learn when jobs are dispatched to it or its organization; its claims already get 401. If that
   becomes unacceptable, shorten the TTL or revoke through Ably's token revocation.

## Consequences

- No held claim requests while Ably is configured: every claim uses `waitSeconds: 0`, and an idle
  harness sends about one claim per job it is woken for instead of about 1,700 a day.
- Pickup within about 2s of dispatch while the harness's Ably connection is up, within one heartbeat
  (≤20s) otherwise (retries, lapsed leases, missed wakes, Ably down).
- Ably is a new external dependency, but only for latency: losing it slows pickup to the heartbeat,
  never stops it, and dispatch never fails on it.
- Harnesses make one more outbound connection (a WebSocket to Ably), and the control panel one more
  outbound call per dispatch (the REST publish).
- The harness has two claim modes to test and reason about; the long-poll stays as the fallback
  until it can be removed.
