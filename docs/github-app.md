# GitHub App

Omniralph talks to GitHub as **one GitHub App per control panel** (one per Vercel environment if
previews connect to GitHub too). The App receives the webhooks, posts reviews and replies, resolves
threads and mints the short-lived clone tokens the credential broker hands to agents: read-only
for every job, and `contents: write` on the one repository only for running `ralph` jobs (so they
can push their branch). Agents never hold a GitHub API token, and review jobs never get a write
credential.

For `ralph` runs ([linear.md](linear.md)) the control panel also opens, updates and marks ready the
run's pull request through the App (Pull requests: write), and the run's branch is pushed by the
agent with the brokered write token. Nothing else is needed for ralph on the GitHub side: the
repository must be connected here and have ralph enabled under **Repository › Settings › Ralph**.

Sign-in with GitHub is a separate, plain **OAuth app** (`AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`, see
[env.md](env.md)). Don't reuse the App for sign-in.

## Permissions and events

| Permission | Access | Used for |
| -- | -- | -- |
| Pull requests | Read and write | Read PRs and diffs, post reviews with inline comments, reply to and resolve review threads; open, update and mark ready ralph runs' PRs |
| Contents | Read and write | Clone tokens brokered to agents (`contents: read`, one repository, ≤ 1 hour); push tokens brokered to running `ralph` jobs only (`contents: write`, one repository, ≤ 1 hour) |
| Issues | Read & write | The `issue_comment` event (PR conversation comments are issue comments) and replies to `@bot` commands in the PR conversation |
| Actions | Read | Ralph's CI-fix loop: the workflow runs and failed jobs of a ralph PR's head commit, and the failed jobs' logs |
| Metadata | Read | Mandatory for every App |

| Event | Triggers |
| -- | -- |
| `pull_request` | Reviews on open, reopen, ready for review and push (synchronize); ralph cleans up after a ralph PR is merged (closed + merged) |
| `issue_comment` | `@bot` commands in the PR conversation |
| `pull_request_review_comment` | `@bot dismiss` and questions in a finding's thread |
| `workflow_run` | Ralph's CI-fix loop: a finished workflow run on a ralph PR's head commit (the reconcile cron is the fallback) |

## Manifest

Replace `https://omniralph.example.com` with your `APP_URL` and pick a unique `name`:

```json
{
  "name": "Omniralph",
  "url": "https://omniralph.example.com",
  "description": "Self-hosted AI code review and Linear-driven builds",
  "public": false,
  "hook_attributes": {
    "url": "https://omniralph.example.com/api/webhooks/github",
    "active": true
  },
  "redirect_url": "https://omniralph.example.com/",
  "setup_url": "https://omniralph.example.com/repositories/github/callback",
  "setup_on_update": true,
  "request_oauth_on_install": false,
  "default_permissions": {
    "pull_requests": "write",
    "contents": "write",
    "issues": "write",
    "actions": "read",
    "metadata": "read"
  },
  "default_events": ["pull_request", "issue_comment", "pull_request_review_comment", "workflow_run"]
}
```

- **Upgrading an existing App** (created before ralph, with `Contents: Read`): change
  **Contents** to **Read and write** under the App's **Permissions & events**, then accept the new
  permissions on each installation (**Settings › Applications › Configure**). Until then, ralph
  jobs can't push; reviews keep working. Apps created before reviews posted replies may also have
  **Pull requests: Read** only; ralph needs **Read and write** to open its PRs.
- **Upgrading an existing App** (created before ralph's CI-fix loop): add **Actions: Read** under
  **Permissions & events**, subscribe to the **Workflow run** event, and accept the new permissions
  on each installation. Until then, ralph can't see why a PR's CI failed and doesn't try to fix it;
  reviews and the rest of ralph keep working.
- `setup_url` + `setup_on_update`: after installing (or changing the installation's repositories)
  GitHub returns to **Repositories › Connect GitHub**'s callback, which records the installation.
- `request_oauth_on_install` must stay **false**: turning it on disables the Setup URL, and the
  callback depends on it.

### Creating the App from the manifest

1. Save this page as `create-app.html` (paste the manifest into the `value`; for an organization
   use `https://github.com/organizations/<org>/settings/apps/new` as the `action`), open it in a
   browser signed in to GitHub and submit it:

   ```html
   <form action="https://github.com/settings/apps/new" method="post">
     <input type="hidden" name="manifest" value='{ …the manifest above… }' />
     <button type="submit">Create the Omniralph GitHub App</button>
   </form>
   ```

2. GitHub creates the App and redirects to `redirect_url?code=<code>`. The control panel doesn't
   handle that redirect; copy `code` from the address bar and, within an hour, exchange it:

   ```sh
   curl -sX POST -H "Accept: application/vnd.github+json" \
     https://api.github.com/app-manifests/<code>/conversions > app.json
   ```

   `app.json` contains `id`, `slug`, `webhook_secret` and `pem` (the private key). Store it somewhere
   safe and delete it once the values are on Vercel.

3. Set on the Vercel project ([deploy-control-panel.md](deploy-control-panel.md)):
   - `GITHUB_APP_ID` = `id`, `GITHUB_APP_SLUG` = `slug`, `GITHUB_WEBHOOK_SECRET` = `webhook_secret`.
   - The private key: preferably import `pem` into a KMS issuer and set `GITHUB_APP_KMS_ISSUER_ID`
     (next section); otherwise set `GITHUB_APP_PRIVATE_KEY` to the PEM.

You can also create the App by hand under **Settings › Developer settings › GitHub Apps › New
GitHub App** with the same URLs, permissions and events. Generate a webhook secret with
`openssl rand -hex 32` and a private key on the App's page.

## Private key in Vercel KMS (optional, recommended)

With KMS the App's private key never sits in an env var. GitHub only accepts **RS256** JWTs and KMS
issuers default to RS512, so set the algorithm explicitly:

```sh
vercel kms import omniralph-github-app-production --key ./app.private-key.pem --algorithm RS256
vercel kms add-grant <issuerId>        # the omniralph project, the environment(s) that use it
vercel kms inspect <issuerId>          # must show "algorithm": "RS256" and "origin": "external"
```

Set `GITHUB_APP_KMS_ISSUER_ID=<issuerId>` and leave `GITHUB_APP_PRIVATE_KEY` unset. To rotate the
key, generate a new one on the App, import it into a **new** issuer and update the variable. See
*KMS issuer setup* in [ADR 0002](adr/0002-agent-auth.md).

## Installing and connecting repositories

As an admin, open **Repositories › Connect GitHub**, install the App on the account or organization
and pick the repositories. GitHub returns to the control panel, which lists the installation's
repositories; select the ones to review and save. New and updated PRs are then reviewed with each
repository's profile (Standard by default).

## GitHub Enterprise Server

Set `GITHUB_API_URL` to the REST base URL (`https://ghe.example.com/api/v3`) and create the App on
the GHES instance (`https://ghe.example.com/settings/apps/new` for the manifest flow).
