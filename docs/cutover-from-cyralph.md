# Cutover from cyralph

Om does everything cyralph does in production: delegated epics built
story by story, @mention requests, live replies, multi-repository epics, Linear attachments,
`cyralph-prepare` blocks, `wip` commits, review and CI follow-up on its PRs/MRs, cleanup after the
merge and self-update. This guide moves every Linear team, project and label from cyralph to
Omniralph and then shuts cyralph down. It needs no code changes, only settings in the control
panel and Linear, and edits to cyralph's `config.json`.

There's no import tool: settings are re-entered by hand ([the mapping](#config-mapping) below), and
cyralph's in-flight sessions are either finished by cyralph or delegated again to Omniralph
([step 5](#5-let-cyralphs-in-flight-sessions-finish-or-re-delegate-them)).

Read first: [linear.md](linear.md) (the Linear side of Om), [deploy-agent.md](deploy-agent.md#coding-work)
(agents that run coding jobs) and [ADR 0003](adr/0003-ralph-orchestration.md) (how the control panel
orchestrates runs).

## How the two differ

- **Where it runs.** cyralph is one process that holds a Linear token, `gh`/`glab` logins and local
  clones, and runs every session itself. In Omniralph the control panel (Vercel) holds the Linear
  app, the GitHub App and GitLab bot token, and orchestrates; agents (`omniralph-agent`) only run
  jobs, with short-lived, job-scoped git credentials and no Linear or code-host API token.
- **Where state lives.** cyralph keeps `sessions.json`, progress logs and worktrees under its state
  directory. Omniralph keeps runs, stories, lanes, requests and messages in Postgres (shown under
  **Coding tasks**); agents keep only branch worktrees and caches.
- **Configuration.** cyralph's `config.json` becomes control-panel settings: env vars on Vercel,
  **Settings › Connections › Linear**, **Fleet › Version policy** (agent version), each agent
  machine's local config (accepted task types, concurrency, pool limits), each repository's coding
  policy and its story and request playbooks.
  Changes apply from a run's next decision, without restarts.
- **Two Linear apps.** Omniralph is its own Linear app (OAuth application). An issue is handled by
  whichever app it's delegated to (or @mentioned); each app's routing only picks the repository.
  While both are installed, never route the same team, project or label in both, and never
  delegate one issue to both: two runs would push to the same branch and fight over the
  sub-issues' states and the PR/MR.

## Config mapping

Every field of cyralph's `config.json` (`src/config.ts`) and where it went. "Fixed" means Omniralph
always behaves like cyralph's default and has no setting for it.

### Top level

| cyralph | Omniralph | Notes |
| -- | -- | -- |
| `port`, `baseUrl` | Not needed | The control panel runs on Vercel at `APP_URL`; webhooks and the OAuth callback use it ([env.md](env.md)). No tunnel. |
| `stateDir` | Not needed | Run state is in Postgres. Agents keep repositories and branch worktrees under their `workspaceRoot` ([deploy-agent.md](deploy-agent.md#workspaceroot-and-disk-usage)). |
| `model`, `fallbackModel` | **Model** / **Fallback model** per repository | Same names and defaults (`opus` / none), set per repository instead of globally. |
| `maxConcurrentSessions` | Max concurrency and concurrency per pool in each agent machine's local config | Per agent; until they move there, every agent runs with the defaults ([deploy-agent.md](deploy-agent.md#central-config)). The `long` pool (coding) limit defaults to max concurrency − 1 (at least 1), so an agent with 2+ slots keeps one for reviews. Use several agents for more parallel runs. |
| `gitlabHosts` | Not needed | Each GitLab connection has its own base URL (**Repos › Add repo › Connect GitLab**), so the code host is known per repository. |
| `blockerPollMinutes` | Fixed | Blockers are re-checked on Linear **Issues** webhooks and by `/api/cron/ralph-reconcile` every 10 minutes. |
| `permissionMode` | Fixed | Coding sessions use `bypassPermissions` in the branch worktree (`dontAsk` when **Allowed tools** is set). Narrow them per repository with **Allowed tools** / **Disallowed tools**. |

### `linear`

| cyralph | Omniralph | Notes |
| -- | -- | -- |
| `accessToken`, `refreshToken` | **Settings › Integrations › Connect Linear** | Installs the Omniralph app (`actor=app`); its tokens are stored encrypted and refreshed automatically. Not copied from cyralph: they belong to cyralph's app. |
| `webhookSecret` | `LINEAR_WEBHOOK_SECRET` | The Omniralph app's own signing secret. |
| `clientId`, `clientSecret` | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` | The Omniralph app's own credentials. `cyralph auth` becomes **Connect Linear**. |
| `workspaceId`, `workspaceName` | Not needed | Recorded when connecting; shown on **Settings › Integrations**. |

### `ralph`

| cyralph | Omniralph | Notes |
| -- | -- | -- |
| `maxAttemptsPerStory` | Fixed: 3 | On the **Coding tasks** path, the story task's `maxAttemptsPerStory` (3 for `builtin:implement-story`). |
| `maxIterationsPerRun` | Fixed: 50 | Story jobs per run. On the **Coding tasks** path, the story task's `maxIterationsPerRun` (50). |
| `materializeStories` | Fixed: on | A PRD in an issue's description is always turned into sub-issues first. |
| `commitPerStory`, `pushPerStory` | Fixed: on | Every finished story is committed and pushed; the remote branch is the only state between jobs (agents can change). On the **Coding tasks** path the story task's `pushTiming` can be `end`: stories are then pushed to a hidden ref (`refs/omniralph/runs/<run>`) and the branch once at the end. |
| `createPullRequest` | Fixed: on | The control panel opens the PR/MR through the GitHub App or GitLab bot. |
| `openPullRequestEarly` | **Open the pull request early** per repository (`openPullRequestEarly`) | Same default (off). |
| `describePullRequest` | Fixed: on | A read-only `ralph.describe-pr` job writes the title and body (on the **Coding tasks** path, a run of the story task's PR description task, `builtin:describe-pr`). |
| `markPrReadyWhenComplete` | Fixed: on | |
| `historyRewrite` | **Rewrite history** per repository (`historyRewrite`) | Same values and default (`when-asked`), plus `always`: rebase (and push with `--force-with-lease`) without being asked, never merging the base branch. |
| `allowPreparation` | The story playbook's `allowPreparation` | Same default (on). |
| `manualLabels` | The organization's tracker labels (`app_settings` `tracker.labels`) | Same default (`manual`), for every repository. |
| `epicCompletedStateType`, `epicCompletedStateName` | The story playbook's `epicCompletedState` | One field: `started` / `completed` (a state type) or a state name such as `In Review`. Empty leaves the epic alone. |

### `github`

| cyralph | Omniralph | Notes |
| -- | -- | -- |
| `webhookSecret` | Not needed (`GITHUB_WEBHOOK_SECRET` is the GitHub App's) | cyralph's separate `/github-webhook` webhook goes away; the GitHub App's webhook delivers everything ([github-app.md](github-app.md)). Remove cyralph's webhook in [step 6](#6-stop-cyralph-and-remove-its-linear-app-and-webhooks). |
| `reviewBots` | Not needed | Omniralph acts on its **own** reviews of Om PRs/MRs and on `@omniralph fix` / `@omniralph` requests from people with write access. Third-party review bots (e.g. cubic) are no longer acted on; turn the Omniralph review on for the repository instead. |
| `reviewPollMinutes` | Not needed | A finished Omniralph review hands its findings to the run directly; there is nothing to poll. |
| `maxReviewRounds` | The request playbook's `maxReviewRounds` | Same default (3). The repository's **Fix review comments and CI failures** (`respondToReviewsAndCi`) turns it off. |

### `ci`

| cyralph | Omniralph | Notes |
| -- | -- | -- |
| `pollMinutes` | Not needed | Failed CI arrives by webhook (GitHub `workflow_run`, GitLab **Pipeline events**), with `/api/cron/ralph-reconcile` (every 10 minutes) as the fallback. `0` (off) becomes **Fix review comments and CI failures** (`respondToReviewsAndCi`) off per repository. |
| `maxFixRounds` | The request playbook's `maxFixRounds` | Same default (3). |

### `autoUpdate`

| cyralph | Omniralph | Notes |
| -- | -- | -- |
| `enabled` | **Fleet › Version policy** | Agents under pm2 update to the desired version (or each release, with `latest`) ([self-update](deploy-agent.md#self-update-pm2)). Agents under systemd or tmux are updated by hand. The control panel itself updates with each Vercel deployment. |
| `intervalMinutes` | Not needed | The desired version arrives with every heartbeat (20s). |
| `remote`, `branch` | Not needed | Agents install published npm versions of `@omniralph/agent`, not a git branch. `latest` (**Track latest on npm**) follows the `latest` dist-tag; a per-agent override pins or tries a version on one host. |
| `buildCommands` | Not needed | Releases are built and tested by CI before they're published. A version that fails to stay up is rolled back automatically and never retried. |

### `repositories[]`

Each cyralph repository becomes a connected repository (**Repos › Add repo › Connect GitHub**
or **Connect GitLab**) with coding on. A repository's own coding policy is its on/off switch, work item
match, extra instructions, open PR early, history rewrite and responding to reviews and CI
(`/api/ui/repositories/{id}/coding`); the rest is its story and request playbooks' (see
[definitions](definitions.md#coding-settings)).

| cyralph | Omniralph | Notes |
| -- | -- | -- |
| `id`, `name` | The repository's full path (`acme/app`, `group/subgroup/project`) | Taken from the code host. |
| `repositoryPath` | Not needed | Agents clone into their own cache (`workspaceRoot`) with brokered credentials. |
| `baseBranch` | The repository's default branch on the code host | Read when a run starts. There's no override; a PR/MR always targets the default branch. |
| `workspaceBaseDir` | Not needed | Branch worktrees live under `<workspaceRoot>/.branches/` on the agent. |
| `teamKeys`, `routingLabels`, `projectKeys`, `projectNames` | Rules on **Settings › Advanced › Routing rules** | Organization-wide, tried top to bottom: e.g. **Labels contains any of** `backend`, then **Project is** `App`, then **Team is** `ENG`, each targeting the repository (cyralph's order: labels, then project, then team). |
| `githubUrl`, `gitlabUrl` | Not needed | The repository question matches the full path or its last segment. Omniralph ignores `[repo=…]` tags in issue descriptions: route those issues with a routing rule instead. |
| `isActive` | The repository's **Coding** switch | Off for a new repository, and it needs a work item match to turn on: only repositories with Coding on are routed to, offered in the repository question or pushed to. |
| `verifyCommands` | The story and request playbooks' `verifyCommands` | |
| `runPrdQualityGates` | The playbooks' `runPrdQualityGates` | **Different default:** on in Omniralph, off in cyralph. Turn it off to keep cyralph's behaviour. |
| `forge`, `gitlabHost` | Not needed | Known from the connection the repository belongs to. |
| `setupCommand` | The playbooks' `worktreeSetupCommand` | |
| `model` | The playbooks' `model` | |
| `allowedTools`, `disallowedTools` | The playbooks' `tools` | A playbook's tools are its runs' tools. |
| `appendInstruction` | **Extra instructions** (`codingInstructions`) | Also appended to request prompts. |
| `historyRewrite`, `allowPreparation` | **Rewrite history**, the story playbook's `allowPreparation` | No global value to override. |
| `promptTemplatePath` | Not supported | Custom templates aren't ported; move what the template added into **Extra instructions**. |
| `respondToReviews` | **Fix review comments and CI failures** (`respondToReviewsAndCi`) | One switch for reviews (Omniralph's own and `@bot` requests) and CI: on when either was. |
| `respondToCiFailures` | **Fix review comments and CI failures** (`respondToReviewsAndCi`) | |
| `cleanupMergedWorktrees`, `unmergedBranchTimeoutMinutes` | **Clean up after the merge**, **Unmerged branch timeout** | Same defaults (on, 60 minutes). |

Pinning a repo to agents (**Repos › Agents**) has no cyralph equivalent: pin a repository to an agent
when only that host has its toolchain.

### Environment variables

| cyralph | Omniralph |
| -- | -- |
| `LINEAR_ACCESS_TOKEN` | Not needed: **Connect Linear** stores the app's tokens. |
| `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET` | Same names on the Vercel project, with the **Omniralph** app's values ([env.md](env.md#linear-app-om)). |
| `GITHUB_WEBHOOK_SECRET` | Same name, different meaning: in Omniralph it's the GitHub App's webhook secret ([github-app.md](github-app.md)). cyralph's value isn't reused. |
| `CYRALPH_CONFIG`, `CYRALPH_HOME` | Not needed: agents read `OMNIRALPH_AGENT_CONFIG` (or `--config`), everything else is central. |
| `CYRALPH_DEBUG` | `OMNIRALPH_LOG_LEVEL=debug` on the agent. |
| `CYRALPH_RELEASE_SHA`, `CYRALPH_SOURCE_DIR`, `CYRALPH_SUPERVISED` | Not needed: set by cyralph's own update supervisor. |
| `ANTHROPIC_API_KEY` (or the host's `claude` login) | The same on the agent host, for the agent's user ([claude-auth.md](claude-auth.md)). |
| `GH_TOKEN` / `gh auth login`, `glab auth login` | Not needed: the control panel opens PRs/MRs, and agents push with brokered credentials. |

## What carries over unchanged

- **`cyralph-prepare` blocks** in manual stories keep working as they are: the session asks **Run
  it** / **I'll do it myself** / **Not yet**, and **Run it** runs them on the agent (unless the
  repository's **Offer to run preparation** is off). There's no need to rename them.
- **PRDs, `> Branch:` lines, `## Quality Gates`, `**Labels:** manual` stories, manual labels,
  blocker relations and replies** (`stop`, `start anyway`, `rerun preparation`, `/ralph` (now also `/coding`), guidance)
  mean the same thing, and the agent session messages keep cyralph's wording.
- **Stash branches move** from `cyralph/stash/<epic>` to `ralph/stash/<epic>`: after the merge,
  **Push to a branch on origin** pushes leftover stashes to `ralph/stash/<epic>`. Existing
  `cyralph/stash/*` branches on origin are left alone; delete them once nobody needs them.
- **`LINEAR.md` files** (and other repository docs or PRD templates) that mention Cyralph can be
  updated after the cutover, when Omniralph is the only builder. They're plain text for people and
  planning tools; nothing reads the name.

## Checklist

Do the steps in order. Each has a check, and [Rollback](#rollback) says how to undo it.

### 0. Before you start

- The control panel is deployed and migrated, and reviews work for the repositories cyralph builds
  ([deploy-control-panel.md](deploy-control-panel.md)).
- The GitHub App has **Contents: Read and write**, **Pull requests: Read and write**, **Actions:
  Read** and the `workflow_run` event, and every installation accepted them
  ([github-app.md](github-app.md)). GitLab bot tokens are service accounts' personal access
  tokens with `api`, and the project webhooks include **Pipeline events** (the connection shows any
  that don't, with **Recreate webhook**; [gitlab.md](gitlab.md)).
- Keep a copy of cyralph's `config.json`: it's the source for the mapping and for a rollback.

### 1. Turn coding on and set the settings per repository

For every entry in cyralph's `repositories[]`:

1. Make sure the repository is connected (**Repos**), and enable the Omniralph review on it
   if cyralph relied on review bots: review responses only come from Omniralph's own reviews.
2. Enter the settings from the [mapping](#config-mapping): the repository's coding policy (extra
   instructions, open PR early, history rewrite, responding to reviews and CI), the organization's
   manual labels, and, where they differ from the built-ins, a custom story and request playbook
   (verify commands, setup command, model, tools, rounds, epic completed state, and
   `runPrdQualityGates` off if cyralph had it unset).
3. Leave its **Coding** switch off for now: turning it on needs the repository's work item match,
   which routes work items to it, so both move in step 4.
4. Leave **Story task** and **Request task** on the built-ins: they run cyralph's loop as coding
   runs, where sessions can't push by themselves
   ([deploy-agent.md](deploy-agent.md#coding-runs)).

**Verify:** the form saves without errors, and the repository is listed as ralph-enabled. Nothing
is delegated to Omniralph yet, so nothing runs.

### 2. Let agents run coding work and set their limits

1. Prepare the agent hosts as in [deploy-agent.md › Coding work](deploy-agent.md#coding-work): a git identity
   for commits, the repositories' toolchains (everything the verify commands, PRD gates and setup
   commands call), and private registry credentials, all for the agent's user. Sessions can use
   any `gh`/`glab` login that user has (see the linked section).
2. Make sure each agent accepts `coding`: its `agent.json` has no `acceptedTaskTypes` (all
   types), or lists `coding` (restart it after editing). Max concurrency (cyralph's
   `maxConcurrentSessions` is a good start) and the `long` pool limit belong to the agent
   machine's local config; until they move there, every agent runs with the defaults
   ([deploy-agent.md](deploy-agent.md#central-config)).
3. For pm2 agents, choose the version with **Fleet › Version policy › Edit** (replaces cyralph's `autoUpdate`).
4. If a repository is pinned to agents, at least one of them needs to accept `coding`.

**Verify:** the agent shows online on **Fleet**;
`curl -s http://127.0.0.1:9310/healthz` on the host says `"connected": true`; for pm2 agents its
status line says **up to date**.

### 3. Install the Omniralph Linear app

Create Omniralph's own Linear OAuth app, set `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and
`LINEAR_WEBHOOK_SECRET` on Vercel, redeploy, and **Connect Linear** from **Settings ›
Integrations** ([linear.md](linear.md#1-create-the-linear-oauth-app), steps 1 to 3). Don't reuse
cyralph's OAuth app: its webhook points at cyralph.

**Verify:** **Settings › Integrations** shows the workspace. In Linear, the Omniralph app can be
picked as an issue's delegate and @mentioned. Delegate a throwaway issue that a routing rule (**Settings ›
Advanced › Routing rules**) sends to a ralph-enabled repository: its
session acknowledges within seconds, the run shows up under **Coding tasks**, a job runs on a
agent that accepts `coding`, and the run ends with a PR/MR. Close that PR/MR afterwards. Also @mention the
app on an issue with a small request and check that it answers in request mode.

### 4. Move routing team by team

For each Linear team (and each project or label cyralph routes on its own):

1. **Stop routing it in cyralph first:** remove the team key, label or project from cyralph's
   `config.json` (`teamKeys`, `routingLabels`, `projectKeys`/`projectNames`). cyralph applies the
   edit without a restart; check its log for the reload (an invalid file is ignored and logged).
2. **Then route it in Omniralph:** add a rule on **Settings › Advanced › Routing rules** (**Team is**, **Labels
   contains any of** or **Project is**) that targets the repository.
3. Tell the team to delegate (and @mention) the **Omniralph** app from now on.

**Verify:** delegate a small issue of that team to Omniralph: it routes to
the expected repository (no "Which repository should I work in…?" question) and runs. A delegation
to cyralph for that team no longer routes there (cyralph asks which repository to use, or says
there's none).

Move one team, watch its first runs, then the next. Keep each team routed in exactly one of the
two apps at any time.

### 5. Let cyralph's in-flight sessions finish or re-delegate them

cyralph keeps working on sessions it already started, even after their team stopped routing to it.
For each one (cyralph's log and `sessions.json`, or its open agent sessions in Linear), either:

- **Let it finish** in cyralph, including its PR/MR follow-up. Keep cyralph running until then; or
- **Re-delegate it:** stop it in cyralph (reply `stop` in its session), then delegate the epic to
  the Omniralph app. Omniralph picks up the same branch (the epic's `> Branch:` line or Linear's
  branch name) from origin, skips stories already completed in Linear, and adopts the PR/MR
  cyralph opened for that branch when it publishes. Uncommitted cyralph work isn't carried over:
  it stays in cyralph's worktree and stashes (see step 6).

Open cyralph PRs/MRs that are only waiting for reviews or CI aren't followed up by Omniralph
(those runs aren't its own). Let cyralph finish them, or merge or fix them by hand.

**Verify:** cyralph's log shows no running or queued session, and no open cyralph PR/MR still
needs a review round or a CI fix.

### 6. Stop cyralph and remove its Linear app and webhooks

1. Stop cyralph: `pm2 stop cyralph` (or whatever name it runs under; `kill` the `cyralph start`
   supervisor if it isn't under pm2).
2. In Linear, **Settings › API › OAuth applications**, delete cyralph's app (this revokes its
   tokens and removes its webhook and agent from the workspace). Remove its delegations and
   mentions from any saved templates or automations.
3. Remove cyralph's GitHub webhook (`https://<cyralph host>/github-webhook`, on repositories, the
   organization or a GitHub App) and stop its tunnel (`cloudflared`/`ngrok`).
4. On the cyralph host, check its worktrees (`<stateDir>/worktrees/`) and stash list for anything
   still wanted; push it to a branch, then archive or delete `~/.cyralph` (state, worktrees,
   releases, attachments). Log the host's `gh`/`glab` out if nothing else uses them.

**Verify:** the cyralph app is gone from Linear's delegate and @mention pickers; Linear and GitHub
show no failing deliveries to cyralph's URLs; delegations on every team route to Omniralph.

### 7. Remove its pm2 entry

```sh
pm2 delete cyralph
pm2 save                     # so `pm2 resurrect` doesn't start it again
```

Remove `cyralph start` from any startup script (Coder template, crontab, systemd unit).

**Verify:** `pm2 ls` no longer lists cyralph, and after a host restart (or `pm2 resurrect`) only
`omniralph-agent` comes back.

### After the cutover

- Update `LINEAR.md` files and docs that mention Cyralph.
- Delete `cyralph/stash/*` branches on origin that nobody needs.
- Archive cyralph's repository when you're confident you won't roll back.

## Rollback

Every step before 6 is reversible from the control panel and cyralph's `config.json`:

| Undo | How |
| -- | -- |
| Step 1 | Turn the repository's **Coding** switch off: new delegations aren't routed there. Stop runs you don't want to continue under **Coding tasks**; their branches and PRs/MRs stay. |
| Step 2 | Remove `coding` from the agent's `acceptedTaskTypes` and restart it (running jobs finish; queued ones wait for another agent that accepts `coding`). Pin **Fleet › Version policy** back to the version pm2 agents ran. |
| Step 3 | **Disconnect** Linear on **Settings › Integrations** (runs can't advance until it's connected again) or delete the Omniralph OAuth app in Linear. |
| Step 4 | For a team: remove it from the repository's Omniralph routing first, **then** add it back to cyralph's `config.json`, and tell the team to delegate to cyralph again. Stop Omniralph runs of that team that shouldn't continue (`stop` in their session, or **Coding tasks › Stop**) and re-delegate them to cyralph, which picks up the pushed branch. |
| Step 5 | Re-delegate stopped epics to cyralph (while it's still installed). |
| Steps 6 and 7 | Harder: restore `~/.cyralph` (or re-create it from the saved `config.json`), recreate cyralph's Linear OAuth app and run `cyralph auth` again, re-add its GitHub webhook and tunnel, and `pm2 start` it. Then roll routing back team by team as for step 4. |

Rolling back never needs a code change: the two apps share nothing but the code hosts and Linear,
and each works from the branch pushed to origin.
