# GitLab

Omniralph talks to GitLab (gitlab.com or self-managed) as a **bot identity**: one access token per
GitLab connection. The control panel uses it to read MRs, post reviews as MR discussions, reply to
and resolve threads, check commenters' access for `@bot` commands, create the project webhooks and
mint short-lived clone tokens for agents. For `ralph` runs ([linear.md](linear.md)) it also mints
the push tokens for running ralph jobs and opens, updates and marks ready the run's merge request.
Agents never see the bot token.

There are no GitLab env vars. The base URL and token are entered under **Repositories › Connect
GitLab** and stored encrypted with `ENCRYPTION_KEY`. Sign-in with GitLab is a separate OAuth
application (`AUTH_GITLAB_*`, see [env.md](env.md)).

## The bot token

Use one of:

- a **group access token** on the group that contains the projects (one token for all of them), or
- a **project access token** per project, or
- a **personal access token** of a dedicated service user (e.g. `omniralph-bot`) that's a member of
  the projects. Use this on gitlab.com Free, where group and project access tokens aren't available.

Requirements:

| Requirement | Why |
| -- | -- |
| Scope **`api`** | Post MR discussions and notes, resolve threads, read members, manage webhooks, create project access tokens, and open/update ralph runs' merge requests. The connect dialog rejects a token without it. |
| Scope **`write_repository`** | Ralph: the bot's token mints `write_repository` project access tokens for ralph jobs to push with, and can't grant more than it has. |
| Role **Maintainer** (or Owner) on every project | Creating the project webhook and **creating project access tokens** both need Maintainer. |
| Project access tokens allowed | The credential broker creates a `read_repository` project access token (Reporter role, named `omniralph-read-repository`) per project for agent clones. It expires the next day (UTC), is cached encrypted and is replaced when it's within 2 hours of expiry. For running `ralph` jobs only, it likewise creates a `write_repository` token (Developer role, named `omniralph-write-repository`), cached and rotated separately; review jobs never get it. Make sure no instance or group setting blocks project access token creation. |

Pick a sensible expiry for the bot token itself and put a reminder in your calendar: when it expires,
reviews and clones stop. To rotate it, create a new token and connect GitLab again with it.

Set `BOT_HANDLE` on the control panel to the bot user's username (for access tokens it's
`project_<id>_bot_…` / `group_<id>_bot_…`, shown on the token's page) so `@` mentions autocomplete
in MR comments, e.g. `@group_42_bot_1a2b review`.

## Connecting projects

1. As an admin, open **Repositories › Connect GitLab**.
2. Enter the base URL (`https://gitlab.com` or your instance, without `/api/v4`), the bot token and
   the project paths (`group/subgroup/project`).
3. The control panel validates the token (user and `api` scope), resolves each project and creates
   a project webhook at `<APP_URL>/api/webhooks/gitlab` for merge request, comment (note) and
   **Pipeline events**, with SSL verification on and a generated secret (checked against
   `X-Gitlab-Token`).

Disconnecting a project deletes its webhook. MRs (open, reopen, marked ready, new commits; drafts
skipped unless the repository's settings include drafts) in enabled projects are then reviewed.

## Ralph

Nothing beyond the requirements above: a bot token with `api` and `write_repository`, Maintainer
on the project, and ralph enabled under **Repository › Settings › Ralph**. Merge requests are
opened as drafts by the bot (titled `Draft: …`) and marked ready when the run finishes. If the
project protects the run's branch, or only allows Maintainers to push, the Developer-role write
token can't push: ralph branches (Linear's branch names, e.g. `user/eng-12-…`) must be pushable by
Developers.

Ralph's CI-fix loop reads the MR's head pipeline, its failed jobs and their traces with the bot
token (scope `api`), and learns that a pipeline finished from the webhook's **Pipeline events** (the
reconcile cron is the fallback). Projects connected before then have webhooks without pipeline
events: connect GitLab again (which replaces each project's webhook) or tick **Pipeline events** on
the project's webhook (**Settings › Webhooks**).

A bot token connected before ralph (scope `api` only) keeps working for reviews. Ralph pushes then
fail until you connect GitLab again with a token that also has `write_repository`.

## Self-managed GitLab

- **Reachability.** The control panel runs on Vercel, so the instance's API must be reachable from
  the public internet (or at least from Vercel), and the instance must be able to send webhooks to
  `APP_URL`. Agents clone directly from the instance over HTTPS, so it must be reachable from the
  agent hosts too.
- **TLS.** Webhooks are created with SSL verification on; `APP_URL` needs a valid certificate (the
  Vercel domain has one). The control panel and agents verify the instance's certificate, so it
  must chain to a public CA (or the hosts must trust your CA).
- **Version.** Project access tokens need GitLab 13.10 or later; token scope validation uses
  `/personal_access_tokens/self` (14.x and later; older versions skip that check).
- **Outbound webhook settings.** If the instance restricts webhook targets (**Admin › Settings ›
  Network › Outbound requests**), allow the control panel's domain.
- **Sign-in.** To sign in with the same instance, register an OAuth application there (scope
  `read_user`, callback `<APP_URL>/api/auth/callback/gitlab`) and set `AUTH_GITLAB_ID`,
  `AUTH_GITLAB_SECRET` and `AUTH_GITLAB_URL=https://gitlab.example.com`.
