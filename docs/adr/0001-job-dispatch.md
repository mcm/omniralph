# ADR 0001: Job dispatch through Vercel Queues (poll mode)

- **Status:** Accepted (US-009). Verified live against the `omniralph` Vercel
  project on 2026-10-04 (TOOL-45): see [Spike](#spike).
- **Date:** 2026-10-04

## Context

The control panel creates jobs (reviews now, `repo.sync` pre-clones and cyralph
runs later) and agents on Coder instances run them. Agents may only make
outbound calls, and only to the control panel. A job must not be lost when an
agent dies mid-run, retryable failures (Claude rate limits) must be redelivered
after a backoff, and jobs must give up after a few attempts.

We need leasing, redelivery, delayed retries and deduplication. We'd rather
not build them ourselves.

## Decision

**Postgres is the source of truth for job state; Vercel Queues (poll mode)
delivers jobs.**

- The `jobs` table holds every job: status, agent, delivery count,
  cancellation flag, result and error. The UI, cancellation and history read
  it. Messages only carry `{ jobId }` (`JobMessage` in
  `packages/shared/src/protocol.ts`).
- `JobDispatcher` (`apps/web/src/lib/dispatch`) is the only code that knows
  how jobs are delivered. `VercelQueuesDispatcher.createAndPublish(job)`
  inserts the row (deduped by `dedupe_key` among queued/running jobs), then
  publishes:
  - to `<capability>-jobs` (e.g. `review-jobs`), or
  - to `<capability>-jobs-agent-<agentId>` when the repo is pinned. With several
    pinned agents it picks the non-revoked one with the fewest active jobs,
    then the latest heartbeat. `repo.sync` jobs name their agent explicitly.
  - with `idempotencyKey = jobId`, `retentionSeconds = 86400`, and
    **deploymentless** (`new QueueClient({ deploymentId: null })`). Messages
    therefore aren't tied to the deployment that published them and survive
    redeploys.
  - `jobs.topic` is only set once publishing has succeeded. If the publish
    fails, the next `createAndPublish` with the same dedupe key publishes the
    existing job again. The idempotency key makes a duplicate publish harmless.
- ESLint (`no-restricted-imports` in `apps/web/eslint.config.mjs`) stops any
  module outside `src/lib/dispatch` from importing `@vercel/queue`.
- All agents use one consumer group, `agents`, on every topic, so they compete
  for messages.
- **Agents never talk to Vercel.** They use `PollingQueueClient` with
  `resolveBaseUrl: (region) => new URL(`${server}/api/agent/queue/${region}`)`.
  The proxy route `apps/web/src/app/api/agent/queue/[region]/[...path]/route.ts`
  authenticates the agent's access token (`requireAgent`). It then forwards to
  `https://{region}.vercel-queue.com` with the control panel's own Vercel OIDC
  token (`@vercel/oidc`) and streams the response back. Its allowlists:
  - **Operations:** only ReceiveMessages (`POST …/topic/<t>/consumer/<g>`),
    AcknowledgeMessage (`DELETE …/lease/<receipt>`) and ExtendLease
    (`PATCH …/lease/<receipt>`). Send and receive-by-ID are refused.
  - **Topics:** the shared topics of the agent's enabled capabilities, plus its
    own pinned topics.
  - **Consumer group:** `agents` only.
  - **Regions:** those in `QUEUE_REGIONS`. The upstream host is always
    `{region}.vercel-queue.com`.
  - **Paths:** exact regexes on the raw URL. `..`, encoded `/`, `\` and `.`,
    and query strings are refused.
  - **Request headers:** only `Accept`, `Content-Type` and `Vqs-*` are
    forwarded. The agent's `Authorization` is replaced.
  - **Bodies:** over 64 KB they're refused (413). `Content-Length` isn't
    trusted.
  - **Redirects:** never followed (`redirect: "manual"` → 502).
  - Everything else gets 403.
- **Lifecycle** (`/api/agent/*`, all authenticated by `requireAgent`):
  1. The agent receives a message and calls `POST /jobs/{id}/start`. This
     atomically sets `running`, the agent and `started_at`, and increments
     `delivery_count`. It returns `run` with the job and a **job token** whose
     scopes come from the capability (`credentials:read` for review). It
     returns `skip` for canceled (incl. cancel requested), completed, failed,
     expired, unknown and capability-disabled jobs; the agent acknowledges
     those. A start beyond the 3rd delivery fails the job and returns
     `skip: max_deliveries`.
  2. The agent runs the job inside the `receive()` handler. The SDK extends the
     lease while the handler runs (see below).
  3. The agent reports:
     - `POST /jobs/{id}/result` → `completed`, then the agent acknowledges.
     - `POST /jobs/{id}/fail { retryable, retryAfterSeconds? }`:
       - Non-retryable, or on the 3rd delivery → `failed` (acknowledge).
       - Otherwise → the job goes back to `queued` and the response is
         `{ status: "retry", retryAfterSeconds }` (default 60). The agent
         doesn't acknowledge. It sets the lease to that delay: the `receive()`
         `retry` directive `{ afterSeconds }` does exactly this
         `changeVisibility`. The message is then redelivered.
     - Only the job's current agent may report. Anyone else (e.g. an agent
       whose lease lapsed and whose job was redelivered elsewhere) gets `409`.
  4. A crashed agent stops extending its lease → the message is redelivered →
     `start` takes the job over → the old agent's reports get 409.
  5. Cancellation: `cancel(jobId)` sets `cancel_requested`. Queued jobs become
     `canceled` at once. Running jobs are listed in the agent's next heartbeat
     response under `cancelJobIds`, and so are running jobs that were taken
     over by another agent.
- **Heartbeat** (`POST /api/agent/heartbeat`, every 20s): the agent reports its
  version, capabilities, running job IDs and free slots. The response carries
  the central config: `maxConcurrency`, `pollIntervalSeconds`,
  `enabledCapabilities`, `capabilityLimits` (effective per-capability caps
  within `maxConcurrency`; the agent only receives from a capability's topics
  while it runs fewer of its jobs), `pinnedRepoIds`, `topics`, `queueRegion` and
  `cancelJobIds`. It also carries **freshly signed job tokens** for the jobs
  that are still running on this agent, so a long job never holds an expired
  15-minute job token, and `jobMessages`: undelivered messages (Linear replies
  to a ralph run) for those jobs. The agent injects each into the job's live
  Claude session and acknowledges it in its next heartbeat as
  `deliveredMessageIds`, or `rejectedMessageIds` when the job has no live
  session to take it; the control panel applies a rejected or never
  acknowledged message another way (as guidance, or a pending request).
- **Expiry:** Vercel Cron calls `GET /api/cron/expire-jobs` hourly
  (`apps/web/vercel.json`, `Authorization: Bearer $CRON_SECRET`). It marks jobs
  still `queued` 24h after creation as `expired`; by then their messages have
  left the queue.

### Agent-side notes (US-010)

These come from reading `@vercel/queue` 0.7.0:

- Create the client with `deploymentId: null`. Outside Vercel there is no
  `VERCEL_DEPLOYMENT_ID`, and a pinned client throws.
- `token` and `headers` are fixed strings per client instance. The automatic
  lease extensions during a long handler reuse them. A review running longer
  than the 15-minute access token would therefore get 401 on its extensions.
  The SDK treats 401 as fatal and stops extending, the lease lapses and the
  job is redelivered while it's still running. The agent must set the current
  access token on every request. One way is the client's `dispatcher` option:
  an undici dispatcher that rewrites `Authorization` from the agent's token
  store.
- The fixed region comes from the heartbeat (`queueRegion`). Messages can only
  be received in the region they were sent to.

## Spike

The AC asks to verify three behaviours against a real Vercel project in the
target region. **No Vercel credentials were available in the implementation
environment** (no CLI login, no `VERCEL_OIDC_TOKEN`). The findings below
therefore come from the `@vercel/queue` 0.7.0 source and README, not from a
live run. The live checks were run afterwards (TOOL-45, 2026-10-04) on
CLI-deployed previews of the `omniralph` project in `iad1`, with a KMS-signed
agent access token and the procedure below. All of them passed, so the
decision stands.

| Question | Finding (SDK source) | Live check |
| -- | -- | -- |
| Deploymentless publishing survives redeploys | `QueueClient({ deploymentId: null })` sets `explicitlyUnpinned`, and `sendMessage` then sends no `Vqs-Deployment-Id`. Poll consumers send none either (`getConsumeDeploymentId()` is undefined when unpinned). The pinned default exists only for push-mode callbacks, which route deliveries to the publishing deployment. | **Passed.** A job published by deployment A was received through the proxy of deployment B, deployed after the publish (`deliveryCount: 1`). |
| `PollingQueueClient` + `resolveBaseUrl` through the proxy, incl. multipart streaming | `resolveBaseUrl(region)` replaces the base URL, and the SDK appends `/api/v3/topic/…`. Receive sends `Accept: multipart/mixed` and parses the response body as a stream (`parseMultipartStream`). The only state it needs is the top-level `Content-Type` boundary, which the proxy passes through. The proxy returns `upstream.body` unbuffered. Covered by `queue-proxy.test.ts` with a multipart upstream. | **Passed.** Receive through the proxy returned `200 multipart/mixed` and the handler got `{ jobId }`; the ack (`DELETE …/lease/…`) returned 204. The proxy refused send, a foreign topic, another consumer group and a region outside `QUEUE_REGIONS` (403), and a missing token (401). |
| Does polling `receive()` auto-extend the lease while the handler runs? | **Yes.** `ConsumerGroup.processMessage` calls `startVisibilityExtension` before invoking the handler. Every `min(60s, max(10s, vt/5))` it re-extends by `visibilityTimeoutSeconds` (default 300, max 3600); transient errors are retried every 3s. It stops on handler completion, then acknowledges. On a thrown error with a `retry` directive, it acknowledges (`{ acknowledge: true }`) or `changeVisibility(afterSeconds)` instead. A crashed process stops extending, so the lease lapses after at most `visibilityTimeoutSeconds`. | **Passed.** With `visibilityTimeoutSeconds: 30` and a 75s handler, the SDK sent `PATCH …/lease/…` every ~10s (7 times, all 200 through the proxy); a second consumer polling every 5s got `empty` 18 times. After killing a consumer (`SIGKILL`) 4s after its last extension, the message was redelivered to the other consumer exactly 30s after that extension (`deliveryCount: 2`). |

**Live verification procedure** (a person with access to the `omniralph`
Vercel project; the region is the first entry of `QUEUE_REGIONS`):

1. Deploy a preview with `QUEUE_REGIONS`, `CRON_SECRET` and KMS configured.
   Enroll a local agent, or use a script with a valid access token.
2. Create a job (`getDispatcher().createAndPublish`, e.g. from a temporary
   route). Redeploy. Receive through
   `PollingQueueClient({ region, deploymentId: null, resolveBaseUrl: r => new URL(`${APP_URL}/api/agent/queue/${r}`), token })`
   and confirm the message arrives after the redeploy.
3. In the same receive, confirm the handler gets the `{ jobId }` payload.
   Multipart streaming then works through the proxy (including Vercel's
   response streaming for route handlers).
4. Use a handler that sleeps longer than `visibilityTimeoutSeconds: 30`. Check
   that the `PATCH …/lease/…` extensions pass the proxy (the function logs
   show them), and that a second consumer doesn't get the message meanwhile.
   Kill the process mid-handler and confirm redelivery after ~30s.
5. Record the results in this table and adjust the decision if any of them
   fails.

## Alternatives considered

- **Postgres as the queue (pg-boss / `SELECT … FOR UPDATE SKIP LOCKED`).** No
  new service, and job state and queue live in one transaction. But agents
  can't reach Neon directly. Every claim, lease renewal and retry would be our
  own endpoint and our own state machine: lease expiry sweeps, visibility
  timeouts, backoff scheduling. That's exactly the mechanics we want to avoid
  writing and testing. Neon's scale-to-zero also makes tight polling loops
  costly.
- **Upstash QStash.** Managed, with retries and delays, but push-only: it
  delivers to an HTTP endpoint. Agents have no public URL (a non-goal), so
  we'd need a pull relay on top, i.e. build a queue again. It would also be
  another vendor and credential outside the Vercel project.
- **Vercel Queues push mode (`handleCallback`).** Delivers to control-panel
  functions, not to agents. Long reviews (minutes) don't belong in a
  function, and the function would have to hand the work to an agent anyway.

Vercel Queues poll mode gives us leasing, redelivery, delayed retry
(`changeVisibility`), idempotent publishing and retention. It needs no extra
vendor or credential: the control panel authenticates with the OIDC token it
already has.

## Breaking points: revisit this decision when

1. We'd have to build queue mechanics that Vercel Queues doesn't provide:
   fair scheduling across repos, priority aging, per-agent rate limiting.
2. We need multi-step orchestration. Evaluate Vercel Workflows first.
3. Beta breaking changes, outages or pricing materially hurt us.
4. Scale: more than 20 agents, or more than 1,000 jobs/day with noticeable
   proxy-invocation cost (every receive, extension and ack is a function
   invocation).
5. The agentless backends (Coder tasks, Modal) need a dispatch model that
   doesn't fit.

When one of these happens we revisit the decision rather than add more
workarounds. The `JobDispatcher` interface and the
`/api/agent/jobs/{id}/start|result|fail` contract don't depend on the
transport, so only `lib/dispatch` and the agent's poll loop would change.

## Consequences

- Every queue call by an agent is one control panel function invocation
  (breaking point 4).
- Messages in a region can only be received there. All topics live in the
  first region of `QUEUE_REGIONS`; multi-region would mean publishing to and
  polling from several.
- The 3-delivery limit is enforced by our `delivery_count`, which counts
  starts, and not by the queue. A message whose `start` never succeeds (e.g.
  the control panel is down) keeps being redelivered until it expires after
  24h, and the cron sweep then expires the job.
