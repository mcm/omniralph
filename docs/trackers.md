# Trackers

Om reads and writes work items through a tracker-neutral layer: the `TrackerGateway` interface
and its neutral types in `packages/tracker` (`@omniralph/tracker`), and a web adapter per tracker
in `apps/web/src/lib/tracker/`. Linear is the first and, for now, only adapter
([linear.md](linear.md) covers setting it up). [ADR 0012](adr/0012-tracker-layer.md) records why
the layer looks the way it does.

This page explains how to add a tracker adapter. Everything outside the adapter (the ralph loop,
triage, routing, the Backlog, Om in chat, the agent's tracker tools) already works with any
`TrackerGateway`, so a new tracker shouldn't need changes there.

## Layout

| Where                                  | What                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/tracker/src/types.ts`        | `TrackerProvider`, the neutral types, `TrackerGateway`, the capability sub-interfaces and the errors                                                      |
| `packages/tracker/src/capabilities.ts` | `hasCapability`, `requireCapability`, `trackerCapabilities`, `GatewayWith<C>`                                                                             |
| `packages/tracker/src/events.ts`       | The neutral webhook events (`TrackerEvent`) and the triage label                                                                                          |
| `packages/tracker/src/routing.ts`      | `RoutingIssue`, the fields routing rules test                                                                                                             |
| `packages/tracker/src/testing/`        | `FakeTrackerGateway` and `NO_CAPABILITIES` (`@omniralph/tracker/testing`)                                                                                 |
| `packages/tracker/src/linear/`         | The Linear adapter: `SdkLinearGateway`, the webhook parser, upload parsing, `FakeLinearGateway`, the fixture workspace                                    |
| `apps/web/src/lib/tracker/adapter.ts`  | `TrackerWebAdapter` and `TrackerExtras`: what the web app needs from a tracker beyond its gateway                                                         |
| `apps/web/src/lib/tracker/adapters.ts` | The registry of web adapters by provider: `trackerAdapter`, `trackerExtras`, `trackerName`, `trackerPromptInfo`, `trackerProviderCapabilities`            |
| `apps/web/src/lib/tracker/*.ts`        | Neutral, database-backed code: gateways for an organization (`client.ts`), event dispatch (`events.ts`), placement, routing fields, settings options      |
| `apps/web/src/lib/tracker/linear/`     | Linear's web adapter: credentials and token refresh (`client.ts`), OAuth (`oauth.ts`), webhook ingest (`ingest.ts`), placement extras, `linearWebAdapter` |
| `apps/web/src/lib/work-items/`         | `WorkItemTracker`, the Backlog's and Om's view of work items, over any gateway (`GatewayWorkItemTracker`), and its contract suite                         |

An oxlint `no-restricted-imports` rule (`apps/web/.oxlintrc.json`) keeps provider modules out of
neutral code: only the provider's own folder, its routes and `lib/tracker/adapters.ts` may import
them. A new provider adds its paths to that rule and to its exemptions.

## 1. The gateway

Write the adapter in `packages/tracker/src/<provider>/` and export it as
`@omniralph/tracker/<provider>` (and its fake as `@omniralph/tracker/<provider>/testing`) from
`packages/tracker/package.json`. The tracker's SDK is a dependency of `packages/tracker` only.

The adapter implements `TrackerGateway`:

- `provider`: its `TrackerProvider` value.
- **Workspace:** `getWorkspace`, `getViewer` (the app user Om acts as), `listTeams`,
  `listProjects`, `listLabels`, `getWorkflowStates(teamId)`, `findLabel`, `createLabel`.
- **Issues:** `getIssue(idOrIdentifier)`, `getChildren`, `getComments`, `getBlockers`,
  `searchIssues`, `listIssues(filter)` (paged by cursor), `createIssue`, `updateIssue`,
  `setIssueState` (by state ID, or the team's first state of a `WorkflowStateType`),
  `addIssueLabels`, `removeIssueLabel`, `createBlocksRelation`, `addComment`, `linkUrl`.

Map the tracker's model onto the neutral one:

- **Teams** are whatever scopes issues and their workflow (a Jira project, a GitHub repository).
  Each has a `key`, the prefix of its issues' identifiers (`ENG` in `ENG-12`).
- **Workflow states** have one of the `WorkflowStateType`s: `triage`, `backlog`, `unstarted`,
  `started`, `completed`, `canceled`. Readiness, story selection and the epic's completed state
  all go by type, so every state needs one.
- **Priority** is `IssuePriority` 0–4: 0 none, 1 urgent, 2 high, 3 medium, 4 low
  (`toIssuePriority` narrows a number).
- **Epics and stories** are an issue and its children (`getChildren`, `parentId`); story order
  and dependencies come from blocks relations (`getBlockers`, `createBlocksRelation`).
- **Errors:** throw `TrackerNotFoundError` for an unknown issue, document or label read by ref,
  and `TrackerInvalidInputError` for input the tracker refuses. Callers turn these into 404s and
  "not found" answers; anything else is treated as the tracker failing.

Reads only your tracker has don't belong on the gateway. Put them on the adapter's own type (as
`LinearGateway` adds `getRoutingFields`, `listProjectMilestones`, `listCycles` and `listUsers`)
and expose them through `TrackerExtras` ([below](#3-the-web-adapter)).

## 2. Capabilities

Four features are optional sub-interfaces on the gateway. Implement the ones your tracker has and
leave the others `undefined`:

| Capability   | Operations                                                                                                                    | What Om does without it                                                                                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`   | `createSessionOnIssue`, `createActivity` (thoughts, actions, elicitations, responses, errors), `updatePlan`, `addExternalUrl` | Reports in the work item's comments (`trackerConversation`): activities become comments (ephemeral ones are skipped, a choice lists its options), the plan a `**Plan**` checklist comment, links go through `linkUrl` |
| `delegation` | `delegateIssue(issueId, delegateId)`                                                                                          | Nothing is delegated: **Delegate to Om** fails with `TrackerCapabilityError`, delegate filters and `createIssue({ delegateId })` are refused; runs start from mentions, the Backlog or chat                           |
| `documents`  | `getDocument(ref)`                                                                                                            | Runs aren't offered the `tracker_get_document` tool                                                                                                                                                                   |
| `uploads`    | `isUploadUrl`, `findUploads(text)`, `downloadUpload`, `uploadFile`                                                            | Runs gather no attachments from work items or replies; images in a drafted work item are left out                                                                                                                     |

Neutral code checks before use: `hasCapability(gateway, "sessions")` narrows the gateway to one
that has it, `requireCapability(gateway, "delegation")` returns the operations or throws
`TrackerCapabilityError`. Never call a capability without one of them.

`uploads.isUploadUrl` and `uploads.findUploads` are synchronous and parse text only (e.g.
Linear's `<linear-image>` tags and `uploads.linear.app` links in `uploads.ts`), so they run without
loading credentials.

## 3. The web adapter

The web app reaches a tracker through its `TrackerWebAdapter` (`apps/web/src/lib/tracker/adapter.ts`).
Write it in `apps/web/src/lib/tracker/<provider>/adapter.ts`:

- `name` ("Linear"), which prompts, Om's chat tools and the UI show, and `conventionsFile`
  (`LINEAR.md`), the repository file triage reads for the project's issue conventions (the
  `tracker.name` and `tracker.conventionsFile` prompt variables).
- `capabilities`: the capabilities its gateways have, known without connecting (run specs use
  it to drop tools the tracker can't serve).
- `getGateway({ db, organizationId, fixtures, refreshTimeoutMs })`: the organization's gateway,
  with its credentials from its `integrations` row (decrypted, refreshed when they're about to
  expire). Throw `TrackerNotConnectedError` (`lib/tracker/errors.ts`) without one.
- `disconnectedGateway()`, a gateway whose every call throws `TrackerNotConnectedError`, and
  `lazyGateway(load)`, one that loads on its first call. Both are proxies: they must return
  nested proxies for the capability properties and answer `provider`, and serve the synchronous
  `uploads.isUploadUrl`/`findUploads` without loading (see `lazyLinearGateway` in
  `lib/tracker/linear/client.ts`).
- `extras(gateway)`: the tracker's `TrackerExtras` (routing fields in one read, placement extras
  such as Linear's milestone and cycle, issues with their routing fields, extra settings lists),
  or `null`. With `null`, neutral code builds routing fields and placement from core reads
  (`readRoutingIssue`, `readIssuePlacement`), so extras are an optimization and a place for
  fields only your tracker has.
- `revokeCredentials(credentials)`, called on disconnect.
- `parseDelivery(payload)` and `replayDelivery(...)`, for the webhook delivery log's replay
  ([below](#4-webhooks-and-events)).

## 4. Webhooks and events

The tracker's webhook gets its own route, `apps/web/src/app/api/webhooks/<provider>/route.ts`,
like `/api/webhooks/linear` (`handleLinearWebhook` in `lib/tracker/linear/ingest.ts`). It:

1. Verifies the delivery (signature, timestamp) and answers 401 or 400 when it fails.
2. Parses it into a neutral `TrackerEvent` with the adapter's parser, a pure function in
   `packages/tracker/src/<provider>/webhook.ts` (Linear's is `classifyWebhook`).
3. Finds the organization whose integration has the delivery's workspace as `external_id`
   (`getIntegrationByExternalId`); a delivery from an unknown workspace is ignored.
4. Records it in the delivery log (`DeliveryLog`, `webhook_events`) and records changed issues
   for the Backlog (`recordWorkItemChange`).
5. Calls `acknowledgeTrackerEvent` before responding (Linear wants an activity on a new session
   within 10 seconds) and `handleTrackerEvent` after (`lib/tracker/events.ts`), with
   `{ db, organizationId, workspaceId }`.

Map the tracker's deliveries onto these events:

| Event                 | When                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `issue_delegated`     | A work item was handed to Om: starts a run, or triage when it needs refining              |
| `issue_mentioned`     | Om was mentioned in a comment (`commentBody`): a request, `/coding` or `/triage`          |
| `session_prompted`    | Someone replied in (or stopped, `signal: "stop"`) a conversation Om is in: steers the run |
| `issue_state_changed` | A work item changed state or was removed: may unblock stories, triggers cleanup when done |
| `triage_requested`    | The `coding:triage` label (`isTriageLabel`) was added: starts triage                      |
| `ignored`             | Anything else, with a `TRACKER_IGNORE_REASONS` code the delivery log shows                |

Every event the parser can't use is `ignored` with a reason, never thrown. The parser decides
what a delivery means for its tracker: Linear's tells a mention from a delegation by the comment
that opened the session.

`issue_delegated`, `issue_mentioned` and `session_prompted` carry a `sessionId`: the conversation
Om reports in, which runs are found by. On a tracker with `sessions` it is the agent session's
ID. On one without, the parser chooses it: a stable ID with the `comments:` prefix
(`COMMENT_CONVERSATION_PREFIX` in `lib/tracker/sessions.ts`), the same on a reply as on the
mention it answers, and Om reports in the work item's comments.

## 5. Registering the provider

1. **The union.** Add the value to `TrackerProvider` and `TRACKER_PROVIDERS`
   (`packages/tracker/src/types.ts`) and to `JOB_TRACKER_PROVIDERS`
   (`packages/shared/src/run-tracker.ts`, the `trackerProvider` of ralph and triage jobs). The
   shared package is bundled into the agent, so this needs an `@omniralph/agent` changeset, and
   jobs of the new provider need the agent release that knows it.
2. **The database.** Add the value to the `integration_provider` (which the `tracker_provider`
   columns use), `work_item_tracker` and `webhook_provider` enums in
   `packages/db/src/schema.ts`, and generate the migration
   (`pnpm --filter @omniralph/db generate`). Credentials go in `integrations`
   (`encrypted_credentials`, the workspace as `external_id`), like Linear's.
3. **The registry.** Add the web adapter to `ADAPTERS` in `apps/web/src/lib/tracker/adapters.ts`.
   The type checker then requires every `Record<TrackerProvider, …>` to name it.
4. **Connections.** Add the provider to `CONNECTION_PROVIDERS`, `CONNECTION_PROVIDER_LABELS`
   and `CONNECTION_PROVIDER_ROLES` (role `tracker`) in `apps/web/src/lib/api/connections.ts`;
   general screens name the tracker with `trackerLabel(provider)` from there. Write the connect
   flow (OAuth or token) and its routes under `app/api/integrations/<provider>/` and
   `app/api/ui/integrations/<provider>/`, and its connection screens.
5. **The default.** Code with no tracker-scoped row to read a provider from (the Backlog's
   `getWorkItemTracker`, routing rules, run specs) uses `DEFAULT_TRACKER_PROVIDER`
   (`lib/tracker/client.ts`). Switch those to the organization's connected tracker
   (`getConnectedTrackerProvider`) when a second one can be connected.
6. **Lint.** Add the adapter's import paths to the `no-restricted-imports` rule in
   `apps/web/.oxlintrc.json`, and its folder and routes to the rule's exemptions.

Nothing else names a provider: prompts take `tracker.name`, Om's chat tools take the connected
tracker's name, and the agent's tracker tools (`tracker_get_issue`, `tracker_list_comments`,
`tracker_search_issues`, `tracker_get_document`, served under `/api/agent/runs/{id}/tracker/*`
with the `tracker:read` scope) call the run's organization's gateway.

## 6. Testing

- **The fake.** `FakeTrackerGateway` (`@omniralph/tracker/testing`) is an in-memory gateway:
  arrange issues with `add({ title, … })`, then assert on its plain fields (`comments`,
  `activities`, `plans`, `delegations`, `stateChanges`, `created`, …). Pass
  `{ capabilities: { sessions: false } }` to switch one capability off, or
  `{ capabilities: NO_CAPABILITIES }` for a tracker with none. Fail a call with
  `failures.set("<method>", error)`. Code under test should take its gateway as a dependency, so
  the fake can stand in.
- **Your adapter's fake.** Give the adapter a fake of its own when it has extras or a webhook
  shape worth testing against (Linear's is `FakeLinearGateway`, `@omniralph/tracker/linear/testing`),
  and run `packages/tracker/src/testing/fake-gateway.test.ts`'s expectations against it.
- **The adapter.** Test the SDK calls against a mocked HTTP API (Linear's tests use `msw`), the
  error mapping and the webhook parser's mapping from deliveries to events.
- **The work item contract.** Run `describeWorkItemTrackerContract`
  (`apps/web/src/lib/work-items/contract.ts`) over a `GatewayWorkItemTracker` on your gateway,
  as `gateway-tracker.test.ts` does for Linear.
- **Without capabilities.** `lib/ralph/tracker-capabilities.test.ts` and
  `lib/triage/tracker-capabilities.test.ts` run an epic and a triage end to end on a fake with no
  capabilities; keep them passing when you change the fallbacks.
