# ADR 0004: Organizations as the tenancy boundary

- **Status:** Accepted (TOOL-121)
- **Date:** 2026-10-07

## Context

Omniralph started as one shared space: every signed-in user saw every integration, code-host
connection, repository, agent, review profile, job and ralph run, and roles (`admin`/`member`)
were instance-wide (`users.role`, plus an `allowed_emails` table next to `ALLOWED_EMAIL_DOMAINS`).
Teams sharing one deployment need to keep their repositories, agents, Linear workspaces and
credentials apart, while one person may work in several teams.

Nothing was live yet, so this change wipes existing data and keeps no backwards compatibility.

## Decision

### Tenancy model

- **Every resource belongs to exactly one organization.** The top-level tenant tables carry
  `organization_id NOT NULL` (FK to `organizations`, `on delete cascade`): `scm_connections`,
  `integrations`, `review_profiles`, `repositories`, `agents`, `agent_enrollments`,
  `app_settings`, `jobs` and `ralph_runs`. Child tables (reviews, findings, rules, ralph lanes,
  stories and messages, agent tokens and audit, pins) inherit their organization through their
  parent and have no column of their own. The migrations that added the columns truncated the
  affected tables (`TRUNCATE … CASCADE`) first.
- **Users belong to any number of organizations** (`organization_members`, PK
  `(organization_id, user_id)`) with a per-organization `organization_role`: `admin` or
  `member`. There is no global role and no super-admin; `users.role` and `allowed_emails` are
  gone. The last admin of an organization can't be demoted, removed or leave.
- **The active organization is picked per browser** (the `omniralph-organization` cookie, no URL
  slug), defaulting to the one the user last picked anywhere (`users.active_organization_id`).
  `getCurrentUser` uses the cookie only while the user is still a member of it. Every page and
  server action works on the active organization; a signed-in user without one lands on
  `/onboarding`. Detail URLs of another organization the user belongs to switch the active
  organization (through `/api/organizations/enter`, since pages can't set cookies, with a
  short-lived token signed for the user so another site's link can't switch it) and
  redirect; for non-members they 404 (`apps/web/src/lib/auth/resource-page.ts`). Tabs of one
  browser share the organization: a tab whose organization was switched in another tab blocks
  until it starts over from the dashboard (`OrganizationGuard`). Per-tab organizations (the
  organization in the URL) are TOOL-210. Guards are org-aware: `assertOrgRole(user, orgId,
  role)` in `apps/web/src/lib/auth/roles.ts`.
- **Anyone who can sign in can create an organization**, becoming its admin. Built-in review
  profiles are seeded into each new organization.
- **Invitations** (`organization_invitations`): admins invite an email with a role; invitations
  expire 14 days after creation and can be revoked. Inviting an email again replaces its pending
  invitation. Invitees see pending invitations in the app after signing in (no emails are sent).
- **Email domains** (`organization_email_domains`): with domains set, invitations and joins are
  only allowed for emails in them; with none, there is no restriction. **Allow anyone with a
  matching email to join** (`organizations.allow_domain_join`, off by default, needs a domain)
  lists the organization on onboarding for matching users, who join as `member`. Existing members
  are kept when domains change.
- **The sign-in gate stays instance-wide** (`apps/web/src/lib/auth/allowlist.ts`): an email whose
  domain is in `ALLOWED_EMAIL_DOMAINS`, or that has a pending, unexpired invitation, may sign in.
  Organization email domains never widen it.
- **App credentials stay deployment-level.** The GitHub App, the GitLab and GitHub sign-in OAuth
  apps and the Linear app are env vars; only their installations and connections are per
  organization.

### Per-organization topics

Capability topics are per organization (`capabilityTopic(capability, organizationId)` in
`packages/shared/src/protocol.ts`):

| Topic | Who publishes | Who polls |
| -- | -- | -- |
| `<capability>-jobs-org-<organizationId>` (e.g. `review-jobs-org-<id>`, `ralph-jobs-org-<id>`) | jobs of that organization that aren't pinned or sticky | agents of that organization with the capability enabled |
| `<capability>-jobs-agent-<agentId>` (e.g. `review-jobs-agent-<id>`, `system-jobs-agent-<id>`) | pinned repositories, ralph runs sticking to an agent, `repo.sync` | that agent only |

- `jobs.organization_id` is set on every job: from the repository (reviews, replies, learned
  rules, `repo.sync`) or the ralph run.
- The dispatcher publishes to the job's organization topic. A pinned agent, a run's sticky agent
  or an explicit target agent is only used when it belongs to the job's organization (a foreign
  target throws, a foreign pin or sticky agent is ignored).
- `agentTopics()` (`apps/web/src/lib/dispatch/config.ts`) returns only the agent's
  organization's capability topics and its own agent topics; the queue proxy refuses every other
  topic. The heartbeat response carries `organizationId`, and the agent daemon
  (`apps/agent/src/daemon.ts`, `topicCapability`) only polls topics matching it.
- The agent API (`getJobForAgent`, `startJob`, `isJobRunningOnAgent`) only acts on jobs of the
  agent's organization, so the credential broker and job-token routes refuse a cross-org job.

### Uniqueness rules

| Resource | Unique on | Effect |
| -- | -- | -- |
| Integration | `(organization_id, provider)` (`integrations_provider_uq`) | At most one Linear workspace per organization. |
| Linear workspace | `(provider, external_id)` (`integrations_provider_external_id_uq`) | A workspace belongs to one organization; connecting it from another is refused until it's disconnected. Linear webhooks resolve their organization from the workspace ID. |
| SCM connection | `(provider, base_url, external_id)` | A GitHub App installation, or a GitLab token user on an instance, belongs to one organization; connecting it from another is refused until it's removed (or, for GitHub, uninstalled). Code-host webhooks resolve their organization from the verifying connection. |
| Review profile | `(organization_id, id)` (primary key) | Profile IDs (`quick`, `standard`, `deep`, …) are unique per organization. Repositories reference `(organization_id, profile_id)`, so a repository can only use its own organization's profiles. |
| App setting | `(organization_id, key)` (primary key) | Settings such as the agents' desired version are per organization. |
| Active ralph run | `(organization_id, linear_issue_id)` | One active run per Linear issue per organization. |

OAuth flows that leave the app (GitHub App install, Linear connect) carry the organization in a
signed `state` (`apps/web/src/lib/auth/signed-state.ts`) bound to a nonce cookie; callbacks
require it to match the admin's active organization and never take the organization from a query
parameter alone. GitLab connect uses the admin's active organization directly.

## Consequences

- A user only sees and acts on data of organizations they belong to; DB and page tests
  (`apps/web/src/app/(app)/organization-isolation.test.ts`, `apps/web/src/app/api/agent/jobs.test.ts`)
  seed two organizations and assert neither leaks into the other.
- Agents can't be shared between organizations: a host serving two organizations runs two
  enrolled agents (separate configs and workspace roots).
- A Linear workspace moves to another organization by disconnecting it first. A GitHub
  installation or GitLab connection moves by removing it first (**Repositories › Code-host
  connections › Remove**, or a GitHub `installation` `deleted` webhook): the connection row is
  deleted with its repositories (and, by cascade, their reviews, rules, pins and ralph runs; GitLab
  project webhooks are deleted first), so its history doesn't move along. There is no
  organization deletion and no transfer of resources.
- A queued job's topic includes its organization ID, so changing an agent's organization isn't
  possible (agents are enrolled into one organization for life).
