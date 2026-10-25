# Live change events

Screens update without a refresh: after every committed write that changes what a screen shows,
the control panel publishes a typed **change event** on Ably. The browser subscribes with its own
token and refetches what the event names through the normal, authorized `/api/ui` endpoints.
Polling remains only as the fallback while the realtime connection is down (or Ably is off).

## Events

The catalogue is `apps/web/src/lib/live/events.ts` (zod schemas and types, safe to import in the
browser). Every Ably message is named `change`, and its data is one event:

```json
{
  "v": 1,
  "resource": "run",
  "ids": ["…"],
  "organizationId": "…",
  "at": "2026-10-25T12:00:00.000Z",
  "runId": "…"
}
```

Events carry **IDs only**, never titles, bodies, payloads or names. `runId` (the run an attempt,
transcript, pull request or webhook event belongs to), `section` and `subjectId` (a settings save)
are optional. The resources are `run`, `transcript`, `pull_request`, `inbox_state`,
`webhook_event`, `settings`, `agent`, `repository`, `connection` and `organization`; the doc
comment on `changeEventSchemas` says what each one's `ids` are.

| Channel                        | Carries                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `org:<organizationId>:changes` | Changes everyone in the organization can see                                     |
| `user:<userId>:changes`        | Per-user state (Inbox Done, Skip, Snooze), and the user's own membership changes |

The agents' wake channels (`org:<id>`, `harness:<id>`, [ADR 0009](adr/0009-ably-wake-signals.md))
are separate and never granted to browsers.

## Recording and publishing

- Write functions in `@omniralph/db` call `recordChange(db, change)` (`packages/db/src/changes.ts`).
  The change goes to the request's collector (AsyncLocalStorage); outside one, recording is a
  no-op. Recorded on a transaction, it is kept only once that transaction commits (`createDb`
  scopes every transaction and savepoint with `withChangeScopes`).
- `apiHandler`, every `/api/harness/*`, webhook, cron and OAuth callback route (`liveRoute`), the
  server actions (`runAdminAction` and friends) and webhook work
  deferred until after the response (`liveDeferred`, `liveWaitUntil`) open a collector
  (`apps/web/src/lib/live/request.ts`). After the response (Next `after()`), its de-duplicated
  changes go out in one Ably REST batch request (`POST /messages`) with a 2-second timeout.
- Publishing never changes a write or a response: with `ABLY_API_KEY` unset, Ably answering an
  error or timing out, the failure is logged once per request and the events are dropped.
- Transcript events are coalesced to at most two per run per second: the first activity of a
  second publishes at once, the second claims the trailing publish (rate-limit key
  `live:transcript:<runId>`), sent when the second ends.
- Agents: heartbeats publish only when an agent goes from offline to online
  (`harnesses.live_online`), and the `agent-liveness` cron (every minute) publishes the agents
  whose last heartbeat is older than the online window going offline.

## Browser token

`GET /api/ui/live/token` (any signed-in user) returns `{ token, expiresAt }`: a JWT signed locally
with the Ably key secret, client ID = the user, valid one hour, with `subscribe` only on
`org:<id>:changes` for each of the user's current memberships and on `user:<userId>:changes`.
It returns `{ "token": null }` when Ably is off. A membership change publishes an `organization`
event on the user's channel, so the client fetches a new token with the new channel list.
