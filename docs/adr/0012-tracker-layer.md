# ADR 0012: A tracker-neutral layer, with Linear as its first adapter

- **Status:** Accepted (TOOL-504). Renames the Linear names of ADRs 0003, 0005 and 0008 (their
  text stays as written).
- **Date:** 2026-11-01

## Context

Omniralph was Linear-shaped end to end. `LinearGateway` (`apps/web/src/lib/linear/gateway.ts`)
was a seam for tests, not a provider abstraction: orchestration called Linear's agent sessions,
delegation, documents and uploads directly, `@linear/sdk` types leaked into the ralph loop, triage,
chat and routing, and the names were Linear's everywhere:

- the database (`ralph_runs.linear_issue_id`, `chat_linear_issue_drafts`, `ralph_run_origin =
  'linear'`, …);
- the agent protocol (the `linear:read` scope, the `linear_*` tools under
  `/api/agent/runs/{id}/linear/*`, the ralph payloads' `linearIssueId`);
- playbooks (`tools.linear`, `toolSettings.linearRead`) and trigger kinds (`linear.delegated`,
  `linear.triage`, `linear.mention`);
- prompts, Om's chat tools (`draft_linear_issue`, `delegate_linear_issue`) and the UI copy.

We want to be able to add a second tracker (Jira, GitHub Issues, Microsoft Lists, see TOOL-501)
by writing an adapter, not by rewriting the orchestrator, and Ralph Loop 2.0 (TOOL-922) builds its
planning model on a neutral issue model. No second tracker is built now.

## Decision

**Trackers are reached through a `TrackerGateway` interface with neutral types, in a new
`packages/tracker` package modelled on `packages/scm`. Linear is its first adapter. Features only
some trackers have are optional capabilities that orchestration checks for and works without.
Every name outside the adapter is neutral, and the agent protocol is renamed outright: agents
older than 2.1.0 don't claim jobs that use it.**

### The package

`@omniralph/tracker` (`packages/tracker`) exports:

- `.`: the `TrackerProvider` union (`"linear"`), the neutral types (`IssueSummary`,
  `IssueComment`, `Blocker`, `WorkflowState` with the `WorkflowStateType` union, `IssuePriority`
  0–4, `Team`, `Project`, `IssueLabel`, `Workspace`, `Viewer`, `CreateIssueInput`, …), the
  `TrackerGateway` interface, the neutral webhook events (`TrackerEvent`), the routing fields
  (`RoutingIssue`) and the errors (`TrackerNotFoundError`, `TrackerInvalidInputError`,
  `TrackerCapabilityError`).
- `./testing`: `FakeTrackerGateway`, an in-memory gateway whose capabilities can be switched off
  (`NO_CAPABILITIES`).
- `./linear` and `./linear/testing`: the Linear adapter (`SdkLinearGateway`, its webhook parser
  `classifyWebhook`, upload parsing), its fake (`FakeLinearGateway`) and its fixture workspace.

`@linear/sdk` is a dependency of this package only. The database-backed parts (credentials,
OAuth, webhook ingest, settings pickers) stay in the web app under `apps/web/src/lib/tracker/`,
with each provider's in `lib/tracker/<provider>/`, behind a `TrackerWebAdapter` registered in
`lib/tracker/adapters.ts`. An oxlint `no-restricted-imports` rule keeps Linear modules out of
everything but the adapter, its routes (`/api/webhooks/linear`, `/api/integrations/linear`,
`/api/ui/integrations/linear`, whose URLs don't change) and the registry.

### Optional capabilities

The gateway's core is what every tracker has: read and search issues, comments, blockers,
children, teams, projects, labels and workflow states; create and update issues, set states,
labels and blocks relations, comment and link URLs. Four features are optional sub-interfaces on
the gateway, present or absent:

| Capability   | Operations                                                        | Without it                                                                                                                    |
| ------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sessions`   | agent sessions on an issue, activities, plan steps, external URLs | `trackerConversation` writes to the work item's comments: activities become comments, the plan a `**Plan**` checklist comment |
| `delegation` | delegate an issue to the app user                                 | delegating fails with `TrackerCapabilityError`; runs start from mentions, the Backlog or chat                                 |
| `documents`  | read a document by ID or slug                                     | the `tracker_get_document` tool isn't offered to runs                                                                         |
| `uploads`    | recognise, find, download and upload the tracker's files          | runs gather no attachments from the tracker                                                                                   |

Call sites check with `hasCapability(gateway, "sessions")` (which narrows the type), get them with
`requireCapability` (which throws `TrackerCapabilityError`), or list them with
`trackerCapabilities`. A web adapter also declares its provider's capabilities statically
(`TrackerWebAdapter.capabilities`), so a run's tools can be resolved without connecting.

Reads only one tracker has (Linear's routing fields in one query, project milestones, cycles and
users) are not capabilities: they sit behind neutral shapes in the provider's `TrackerExtras`
(`trackerExtras(gateway)`), and neutral code has a fallback built from core reads when a tracker
has none (`readRoutingIssue`, `readIssuePlacement`).

We considered a single `capabilities` record of booleans next to always-present methods. Optional
sub-interfaces were chosen because the type checker then forces every call site to handle the
missing case, and a fake turns a capability off by leaving the property out.

### Webhook events

Each adapter's webhook parser normalizes its tracker's deliveries into neutral events:
`issue_delegated` and `issue_mentioned` (a session started), `session_prompted`,
`issue_state_changed`, `triage_requested` and `ignored` with a reason code. The adapter decides
what its tracker's delivery means (e.g. Linear's parser tells a mention from a delegation);
`handleTrackerEvent` and `acknowledgeTrackerEvent` (`lib/tracker/events.ts`) dispatch them
without knowing the tracker.

### Neutral names

- **Database.** The `linear_*` tables, columns and indexes are renamed with `ALTER … RENAME`,
  keeping the data (migration `0122_tracker_neutral_schema`): `ralph_runs.tracker_issue_id`,
  `tracker_session_id`, `chat_tracker_issue_drafts`, `chat_tracker_delegations`, … Tracker-scoped
  rows (`ralph_runs`, `ralph_stories`, `triage_runs`, the chat drafts and delegations) gain a
  `tracker_provider` column (default `linear`), and `ralph_run_origin` is `tracker` or `chat`.
  The only `linear` left is the provider value. Stored values are rewritten by data migrations:
  custom playbooks' tools and settings (0123), trigger kinds in `ralph_messages` and job payloads
  (0124), and Om's chat tool names in stored chat messages (0125).
- **Agent protocol.** The scope is `tracker:read`, the tools are `tracker_get_issue`,
  `tracker_list_comments`, `tracker_search_issues` and `tracker_get_document`, served under
  `/api/agent/runs/{id}/tracker/*`; the ralph payloads carry `trackerIssueId`, `trackerProvider`,
  `trackerName` and `source: "tracker"`.
- **Playbooks.** `tools.tracker` and `toolSettings.trackerRead`; trigger kinds
  `tracker.delegated`, `tracker.triage`, `tracker.mention`; prompt variables `tracker.name` and
  `tracker.conventionsFile` (`LINEAR.md` for Linear) where a prompt names the tracker.
- **Om's chat tools.** `draft_tracker_issue` and `delegate_tracker_issue`; the chat prompt names
  the connected tracker from data.
- **UI and docs.** General surfaces say "work item" and name the provider from data
  (`trackerLabel`); the Linear connection and OAuth screens still say Linear.

### Breaking agent compatibility

The agent protocol is renamed outright, with no aliases for the Linear names. Keeping both would
mean every route, scope check, tool list and payload schema carrying two names for as long as an
old agent might be running, for a fleet we deploy ourselves. Instead, jobs that use the renamed
protocol carry a minimum agent version, `AGENT_VERSION_FOR_TRACKER` (2.1.0, in
`packages/tasks/src/requirements.ts`; `TRACKER_PROTOCOL_MIN_AGENT_VERSION` in
`@omniralph/shared`): every coding run (its ralph payloads carry the tracker fields) and every run
whose playbook turns on `toolSettings.trackerRead`. Older agents leave those jobs queued rather
than failing them.

## Alternatives considered

- **Keep `LinearGateway` and add a second gateway beside it.** Every consumer would branch on the
  provider, and the Linear names in the schema and protocol would stay. Rejected: the second
  tracker would be a rewrite of every consumer.
- **A lowest-common-denominator gateway with no Linear-only features.** Linear's agent sessions,
  plans and delegation are how Om reports today; dropping them would change behavior for every
  current user. Optional capabilities keep them and give other trackers a defined fallback.
- **Compatibility aliases for old agents** (accept `linear:read`, serve `/linear/*` too). Rejected
  as above: the control panel and the agent ship together, and the version floor makes the cutover
  safe.

## Consequences

- Adding a tracker means an adapter in `packages/tracker/src/<provider>/`, a web adapter in
  `apps/web/src/lib/tracker/<provider>/`, its routes and connection screens, and a provider value
  in the enums; see [trackers.md](../trackers.md).
- The ralph, triage and chat suites run against both the Linear fake and a fake with no optional
  capabilities, so the fallbacks stay working while only Linear exists.
- After this release the control panel and `@omniralph/agent` 2.1.0 must ship together: an agent
  older than 2.1.0 claims no coding runs and no tracker-reading runs, including Om's own.
- An organization connects one tracker at a time. Code that has no tracker-scoped row to read the
  provider from uses `DEFAULT_TRACKER_PROVIDER` (`lib/tracker/client.ts`); a second tracker has to
  replace those defaults with the organization's connected provider
  (`getConnectedTrackerProvider`).
