# GitLab

Omniralph talks to GitLab (gitlab.com or self-managed) as a **bot identity**: one access token per
GitLab connection. The control panel uses it to read MRs, post reviews as MR discussions, reply to
and resolve threads, check commenters' access for `@bot` commands, create the project webhooks and
mint short-lived clone tokens for agents. For `ralph` runs ([linear.md](linear.md)) it also mints
the push tokens for running coding jobs and opens, updates and marks ready the run's merge request.
Agents never see the bot token.

There are no GitLab env vars. The base URL and token are entered under **Repos › Add repo › Connect
GitLab** and stored encrypted with `ENCRYPTION_KEY`. Sign-in with GitLab is a separate OAuth
application (`AUTH_GITLAB_*`, see [env.md](env.md)).

## The bot token

The bot token is the **personal access token of a GitLab service account**: a user that exists
only for automation, doesn't take a license seat and isn't tied to a person. Name it after the bot
(e.g. `omniralph`): its username is the bot's `@` handle.

- **Self-managed** (Premium or Ultimate): an administrator creates an instance service account in
  the Admin area's **Service accounts** page (or with `POST /api/v4/service_accounts`), then a
  personal access token for it with scope `api` (from that page, or with
  `POST /api/v4/users/:id/personal_access_tokens`).
- **gitlab.com** (Premium or Ultimate): an Owner of the top-level group creates a group service
  account under the group's **Settings › Service accounts** (or with
  `POST /api/v4/groups/:id/service_accounts`), then a personal access token for it with scope `api`
  from its **Manage access tokens** menu (or with
  `POST /api/v4/groups/:id/service_accounts/:user_id/personal_access_tokens`).

Then add the service account as a **Maintainer** of the projects (or of their group).

Without service accounts (e.g. GitLab Free), use the personal access token of a **dedicated real
user** (e.g. `omniralph-bot`) that nobody signs in as for anything else.

**Group and project access tokens are not supported.** Agents clone and push with project access
tokens that the bot mints, and GitLab doesn't let an access token's bot user create access tokens:
every clone would fail with `400 User does not have permission to create project access token`.
**Connect GitLab** rejects them, and an existing connection that uses one is flagged on the
connection (see [Connection health](#connection-health)): connect GitLab again with a service
account's token.

Requirements:

| Requirement                                     | Why                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope **`api`** (the only one needed)           | Everything the bot does through the API, including minting project access tokens and rotating itself. The minted tokens' rights come from the bot's role, not its scopes. |
| Role **Maintainer** (or Owner) on every project | Creating the project webhook and minting project access tokens. The project picker only lists projects the bot maintains.                                                 |
| Project access tokens allowed                   | Make sure no instance or group setting blocks project access token creation. On gitlab.com they need Premium or Ultimate.                                                 |

The expiry you pick when creating the token only has to last until the first daily rotation (see
[Token rotation](#token-rotation)).

What the bot does, and the role each action needs:

| Action                                                        | Role needed    |
| ------------------------------------------------------------- | -------------- |
| Create, delete and check project webhooks                     | **Maintainer** |
| Mint project access tokens for agents' clones and Om's pushes | **Maintainer** |
| Read merge requests, diffs, members, pipelines and job logs   | Reporter       |
| Post reviews as MR discussions, reply to and resolve threads  | Developer      |
| Open, update and mark ready Om's merge requests               | Developer      |

The credential broker mints a `read_repository` project access token (Reporter role, named
`omniralph-read-repository`) per project for agent clones. It expires the next day (UTC), is cached
encrypted and is replaced when it's within 2 hours of expiry. For running `ralph` jobs only, it
likewise mints a `write_repository` token (Developer role, named `omniralph-write-repository`),
cached and rotated separately; review jobs never get it. Neither needs anything on the bot token
beyond `api`.

The bot's `@` handle on GitLab is the service account's username (shown on the connection as
`<username> @ <host>`), so mentions autocomplete in MR comments, e.g. `@omniralph review`. There is
nothing to configure: `BOT_HANDLE` only applies to GitHub.

## Connecting projects

1. As an admin of the Omniralph organization, open **Repos › Add repo › Connect GitLab**.
2. Enter the base URL (`https://gitlab.com` or your instance, without `/api/v4`) and the bot token.
3. The control panel checks the token (it works, has the `api` scope and isn't a group or project
   access token), stores the connection and opens its project picker: every unarchived project the
   bot is a **Maintainer** (or Owner) of, up to 1,000. Tick the projects to add and save.
4. For each added project it first mints a clone token, so a project the bot can't mint for
   fails here instead of at the first agent clone. It then creates a project webhook at
   `<APP_URL>/api/webhooks/gitlab` for merge request, comment (note) and **Pipeline events**, with
   SSL verification on and a generated secret (checked against `X-Gitlab-Token`). Projects that
   fail are named in a warning with GitLab's message and aren't connected; the others are.

Merge request events also tell Omniralph where each merge request that Om opened stands: draft or
not, waiting for its reviewers, approved (approvals by the bot user don't count), merged or closed.

The picker is the only way to add projects, and it only ever adds: projects already connected are
shown as connected and never changed. To add more later, open **Repos › Add repo** and choose the
connection. A project missing from the picker isn't maintained by the bot: make the service account
a Maintainer of it on GitLab.

**Remove repo…** in a repo's ⋯ menu (or its Danger zone) removes one project: Reviews, Coding and
Ask stop, its work item match and agent pins are removed and its project webhook is deleted (a
warning names it if GitLab refuses); its review history is kept. Adding it again creates a new
webhook and starts it with Reviews and Ask on and Coding off.

Connecting GitLab again with a new token of the same bot user (e.g. after a lost token) updates
the existing connection's token and keeps its projects and webhooks.

The connection (the instance's base URL plus the bot token's user) belongs to that organization:
its projects, reviews and jobs are only visible to its members and handled by its agents. The same
bot user on the same instance can't be connected to a second organization ("already connected to
another organization"); give each organization its own service account, or remove the connection
from the first organization.

Removing a connection (admins, `DELETE /api/ui/scm-connections/{id}`) deletes it: the webhooks of
its connected projects are deleted from GitLab (a webhook that can't be deleted is reported, so you
can remove it under the project's **Settings › Webhooks**), then the connection, its projects and
their reviews, rules, agent pins and coding runs. The bot user can then be connected again, from
this or another organization.

Disconnecting a project deletes its webhook. MRs (open, reopen, marked ready, new commits; drafts
skipped unless the repository's settings include drafts) in enabled projects are then reviewed.

## Token rotation

A daily cron (`/api/cron/gitlab-maintenance`, 04:45 UTC) rotates each connection's bot token with
GitLab's `POST /personal_access_tokens/self/rotate`: the new token expires 7 days later and is
stored encrypted in place of the old one, which GitLab revokes at once. No admin action is needed,
and the token you pasted stops working after the first rotation, so don't use it anywhere else.
Requests that were using the old token retry once with the new one. A token rotated less than an
hour ago (by an overlapping or repeated run of the cron) isn't rotated again.

Admins can also rotate a connection's token on demand (`POST /api/ui/connections/gitlab/{id}/rotate`,
the connection page's "Rotate token"), which runs the same rotation and health check right away,
or replace it with a new token of the same GitLab user (`PUT /api/ui/connections/gitlab/{id}`);
a token of another GitLab user is refused, since it belongs on a new connection.

- If the instance has no self-rotation (older than GitLab 16.10), the token isn't rotated: the
  connection shows a warning with the token's expiry. Connect GitLab again with a new token before
  it expires.
- If a rotation fails, the connection shows it with GitLab's message, and the next day's run tries
  again. If GitLab rotated the token but storing it failed, the old token is revoked and the new one
  lost: the connection shows that the token is rejected. Create a new token for the service account
  and connect GitLab again.

## Connection health

After rotating, the same cron checks each connection (read-only). **Repos › Add repo**
shows each GitLab connection's token expiry, when it was last checked ("Not checked
yet" before the first run) and a warning listing its problems:

| Problem                       | What to do                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Token rejected                | It's invalid, expired or revoked: connect GitLab again with a new token.                                       |
| Missing `api` scope           | Connect GitLab again with a token that has `api`.                                                              |
| Group or project access token | Agents' clones and pushes fail. Connect GitLab again with a service account's personal access token.           |
| Token expiring (≤ 3 days)     | Normally rotation prevents this; if it isn't rotated in time, connect GitLab again with a new token.           |
| Rotation unsupported / failed | See [Token rotation](#token-rotation).                                                                         |
| Webhook missing               | The project's webhook was deleted (or never created): reviews and replies won't trigger. **Recreate webhook**. |
| Webhook outdated              | It lacks merge request, comment or pipeline events, or SSL verification. **Recreate webhook**.                 |

Webhooks are never changed automatically, since one may have been removed or edited on purpose.
**Recreate webhook** (admins, next to each webhook problem) deletes the project's stored webhook if
it still exists, creates a new one with the current events and secret, and clears the problem.

## Om

Nothing beyond the requirements above: the service account's token with `api`, Maintainer on the
project, and the repository's Coding switch on (it needs a work item match). Merge requests are opened as
drafts by the bot (titled `Draft: …`) and marked ready when the run finishes. If the project
protects the run's branch, or only allows Maintainers to push, the Developer-role write token can't
push: Om's branches (Linear's branch names, e.g. `user/eng-12-…`) must be pushable by Developers.

Omniralph's own review findings on an Om MR, and `@bot fix [text]` (or any other `@bot` request
outside a finding's thread, or in one when the run has a Linear agent session) from users with at least Developer access, become requests that Om
works on and pushes to the MR's branch ([linear.md](linear.md#reviews-and-bot-requests-on-om-prsmrs));
they use the merge request (note) events the webhook already has.

After an Om MR merges, the webhook's merge request events (action `merge`) start the cleanup of
its worktree and local branch on the agent (the reconcile cron is the fallback); nothing else is
needed for it.

Om's CI-fix loop reads the MR's head pipeline, its failed jobs and their traces with the bot
token, and learns that a pipeline finished from the webhook's **Pipeline events** (the reconcile
cron is the fallback). A webhook without pipeline events is reported as outdated on the connection:
use **Recreate webhook** there (or tick **Pipeline events** on the project's **Settings ›
Webhooks**).

Unlike cyralph, agents need no `glab` login and no `gitlabHosts` entry: the connection's base URL
says where each project lives ([cutover-from-cyralph.md](cutover-from-cyralph.md)).

## Self-managed GitLab

- **Reachability.** The control panel runs on Vercel, so the instance's API must be reachable from
  the public internet (or at least from Vercel), and the instance must be able to send webhooks to
  `APP_URL`. Agents clone directly from the instance over HTTPS, so it must be reachable from the
  agent hosts too.
- **TLS.** Webhooks are created with SSL verification on; `APP_URL` needs a valid certificate (the
  Vercel domain has one). The control panel and agents verify the instance's certificate, so it
  must chain to a public CA (or the hosts must trust your CA).
- **Version.** Daily token rotation needs GitLab 16.10 or later (older versions keep the token and
  warn before it expires); token scope and expiry checks use `/personal_access_tokens/self` (older
  versions skip them).
- **Outbound webhook settings.** If the instance restricts webhook targets (**Admin › Settings ›
  Network › Outbound requests**), allow the control panel's domain.
- **Sign-in.** To sign in with the same instance, register an OAuth application there (scope
  `read_user`, callback `<APP_URL>/api/auth/callback/gitlab`) and set `AUTH_GITLAB_ID`,
  `AUTH_GITLAB_SECRET` and `AUTH_GITLAB_URL=https://gitlab.example.com`.
