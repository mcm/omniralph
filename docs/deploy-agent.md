# Deploying an agent

`omniralph-agent` is a Node 22 daemon that pulls jobs through the control panel and runs them with
the Claude Agent SDK. It only makes **outbound HTTPS** calls: to the control panel (API and queue
proxy) and to the code host (git clone/fetch with brokered, read-only tokens; `ralph` jobs also
push with brokered write tokens). It opens no port except an optional `/healthz` on `127.0.0.1`.

This guide sets one up on a Coder workspace, running as the **workspace user** (`coder`): the
agent's config, repo cache and Claude login live in that user's home, which the workspace persists.
On a dedicated or shared server you may want a **dedicated Unix user** instead, to keep the
agent's refresh token and Claude login away from other sessions on the host (see
[Optional: a dedicated user](#optional-a-dedicated-user)). The rest of this guide calls whichever
user runs the agent *the agent's user*.

## Prerequisites

- Node 22 (≥ 22.12) on the agent user's `PATH`. On Coder the workspace's Node (system-wide or
  nvm) is fine. For a dedicated user or a systemd unit, install it system-wide (e.g.
  `/usr/bin/node`): a Node installed with nvm under `/home/coder` isn't visible to other users.
- git ≥ 2.40 (2.44+ recommended: older versions lazily fetch commits while checking whether they're
  cached).
- `sudo` on the host only if you create a dedicated user or install a systemd unit.
- An admin account in the control panel organization the agent should serve.
- For the `ralph` capability, also a git identity and the target repositories' toolchains: see
  [Ralph](#ralph).

### Coder specifics

- Coder workspaces usually persist only the workspace user's home volume (`/home/coder`). Running
  as `coder` keeps the agent's config (`~/.config/omniralph/`), repo cache (`~/.omniralph/repos`)
  and Claude login across rebuilds and restarts.
- `/etc/systemd/system` and anything outside `/home/coder` (including users created with
  `useradd`) are lost when the workspace is rebuilt, and for container templates on every restart.
  Container-based workspaces often have no systemd at all: use pm2 or tmux there (see below), started
  from the template's startup script.
- The agent is identified by its config file, not by the machine. A rebuilt workspace that kept the
  agent's home keeps working; one that lost it has to be enrolled again.

## 1. Choose the agent's user

On a Coder workspace, run the agent as the workspace user: there's nothing to create, and
everything it writes stays on the persistent home volume. The config file is mode 0600 (the agent
refuses to start if group or others can read it).

Running as your own user means the agent's sessions can reach whatever that user can: your files,
and any `gh`/`glab` logins, SSH keys and registry credentials in your home. Review sessions are
read-only, but ralph sessions run commands with full permissions in their worktree (see
[Host prerequisites](#host-prerequisites)). If that matters on the workspace, use a dedicated user.

### Optional: a dedicated user

On a dedicated server (or a host shared with other people or tools), run the agent as its own
Unix user:

```sh
sudo useradd --system --create-home --home-dir /home/omniralph --shell /bin/bash omniralph
sudo chmod 700 /home/omniralph
sudo -iu omniralph                                # run the steps below as this user
```

The home is 0700 and the config file 0600, so other users and their shells can't read
`~omniralph/.config/omniralph/agent.json` or the agent's Claude login, and the agent can't read
their homes. This separation protects against accidental and tool-driven access (a prompt-injected
session reading files it shouldn't). A user with passwordless `sudo` can still become `omniralph`;
remove that if you need a hard boundary.

On Coder, a dedicated user doesn't survive a rebuild: re-create it (and any unit) from the
template's startup script and keep its home on persistent storage (e.g.
`useradd --home-dir /home/coder/.omniralph-agent/home …`, mode 0700).

## 2. Install

The agent is published as the public npm package `@omniralph/agent`; installing it needs no npm
token. As the agent's user:

```sh
npm config set prefix ~/.local                    # global installs go to ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"              # also add this to ~/.profile
npm install -g @omniralph/agent
omniralph-agent --version
```

If the user's npm already installs global packages somewhere it can write (e.g. an nvm-managed
Node), skip the `prefix` line.

To upgrade by hand: stop the agent, run `npm install -g @omniralph/agent@latest`,
then start it again. Agents run under pm2 can update themselves instead (see
[Self-update](#self-update-pm2)). See [apps/agent/README.md](../apps/agent/README.md) for the release procedure.

Up to 0.3.0 the package was `@iamthemcmaster/omniralph-agent`. Hosts on 0.3.0 or earlier can't
self-update to `@omniralph/agent`: upgrade them by hand once
(`npm uninstall -g @iamthemcmaster/omniralph-agent && npm install -g @omniralph/agent@latest`, then
restart the agent). See [apps/agent/README.md](../apps/agent/README.md#from-030-or-earlier-iamthemcmasteromniralph-agent).

## 3. Log the agent's user in to Claude

As the agent's user:

```sh
curl -fsSL https://claude.ai/install.sh | bash    # installs claude to ~/.local/bin, if not installed yet
claude                                            # log in, then /exit
claude -p "say ok"                                # works non-interactively
```

The Agent SDK bundles Claude Code and uses this login. On a Coder workspace where you already use
`claude`, the agent uses your existing login (and shares its rate limits). Alternatively set
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the agent's environment. See
[claude-auth.md](claude-auth.md), including the note on Anthropic's terms for subscription auth.

## 4. Enroll

Agents belong to an **organization**: the one active when the enrollment token was created. An
agent only receives, and only gets credentials for, that organization's jobs, and only its members
see it. To serve several organizations from one host, enroll one agent per organization (each with
its own `--config` and `--workspace-root`, or as its own user).

As an admin of that organization, open **Agents › Enroll agent** in the control panel. It shows a one-time command with
an enrollment token (single use, valid for 1 hour). Run it as the agent's user:

```sh
omniralph-agent enroll --server https://omniralph.example.com --token <enrollment-token> \
  --name coder-dev-1 --workspace-root ~/.omniralph/repos
```

`--name` defaults to the hostname and `--workspace-root` to `~/.omniralph/repos`.

This writes `~/.config/omniralph/agent.json` (mode 0600, directory 0700) with the server URL, agent
ID, refresh token and `workspaceRoot`. That's the agent's entire local configuration. `--config
<file>` or `OMNIRALPH_AGENT_CONFIG` choose another path, for `enroll` and `start` alike.

The refresh token rotates every ~15 minutes and is rewritten atomically. **Never copy the file to
another host or restore an old backup of it**: presenting an old refresh token looks like token
theft and revokes the agent (see *Re-enrollment*). To run another agent, enroll it separately.

## 5. Run it

On a Coder workspace, use pm2 (restarts on exit, [self-updates](#self-update-pm2)) or tmux,
started from the template's startup script. Use systemd on hosts that have it, typically with a
dedicated user.

### pm2

pm2 restarts the agent when it exits and keeps its logs. Install it as the agent's user
(`npm install -g pm2`), enroll first (`start` exits at once without `agent.json`), then, as the
agent's user:

```sh
pm2 start "$(command -v omniralph-agent)" --name omniralph-agent \
  --kill-timeout 90000 --restart-delay 30000 --max-restarts 5 \
  -- start --healthz-port 9310
pm2 save                                   # remember it for `pm2 resurrect`
pm2 logs omniralph-agent                   # pino JSON logs
curl -s http://127.0.0.1:9310/healthz      # {"status":"ok","connected":true,…}
```

- `--kill-timeout 90000`: pm2 sends SIGINT (handled like SIGTERM) and by default kills the process
  after 1.6s. The agent gives running jobs up to 60s, so allow 90s.
- `--restart-delay 30000`: wait 30s between restarts, so a crashing agent doesn't hammer the
  control panel.
- `--max-restarts 5`: pm2 only counts restarts within `min_uptime` (default 1s; the CLI has no flag
  for it). A "re-enrollment required" exit can take longer than that, so pm2 may keep restarting
  the agent every 30s. That's harmless, but stop it (`pm2 stop omniralph-agent`) before enrolling
  again.
- After a reboot or workspace restart, run `pm2 resurrect`: put it in the Coder template's startup
  script. On hosts with systemd, `pm2 startup` can do this instead.
- pm2 captures the environment when the process is first started. After changing
  `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or `OMNIRALPH_LOG_LEVEL`, run
  `pm2 restart omniralph-agent --update-env`.
- To upgrade: choose a version on **Settings › Agents** and the agent updates itself (see below),
  or trigger an update with **Update now** on the agent's page or `omniralph-agent update` on the
  host ([Triggering an update](#triggering-an-update)). By hand: `npm install -g @omniralph/agent@latest && pm2 restart omniralph-agent`.
- Don't pass `--stop-exit-codes 0` or `--no-autorestart`: the agent exits with code 0 after a
  self-update and relies on pm2 to start it again.

### tmux

As the agent's user:

```sh
tmux new-session -d -s omniralph-agent \
  'omniralph-agent start --healthz-port 9310 2>&1 | tee -a ~/agent.log'
tmux attach -t omniralph-agent             # Ctrl-b d to detach
```

tmux doesn't restart the agent when it exits, and doesn't start it after a reboot or workspace
restart: put the first command in the Coder template's startup script. Stop it with `Ctrl-c` in the
session (SIGINT is handled like SIGTERM). With a dedicated user, prefix both commands with
`sudo -iu omniralph`.

### systemd

On hosts with systemd, a unit restarts the agent and starts it at boot. This example runs it as
the dedicated `omniralph` user from [Optional: a dedicated user](#optional-a-dedicated-user); for
another user, change `User=`, `Group=` and the `/home/omniralph` paths.

`/etc/systemd/system/omniralph-agent.service`:

```ini
[Unit]
Description=Omniralph agent
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=omniralph
Group=omniralph
WorkingDirectory=/home/omniralph
Environment=OMNIRALPH_LOG_LEVEL=info
Environment=PATH=/home/omniralph/.local/bin:/usr/local/bin:/usr/bin:/bin
# Optional overrides (ANTHROPIC_API_KEY=… or CLAUDE_CODE_OAUTH_TOKEN=…); root-owned, mode 0600.
EnvironmentFile=-/etc/omniralph/agent.env
ExecStart=/usr/bin/node /home/omniralph/.local/lib/node_modules/@omniralph/agent/dist/cli.js start --healthz-port 9310
# SIGTERM: stop polling, give running jobs up to 60s; unfinished jobs are redelivered.
KillSignal=SIGTERM
TimeoutStopSec=90
Restart=on-failure
RestartSec=30

# Hardening
NoNewPrivileges=yes
# Hide every home directory (incl. /home/coder and /root), then expose only the agent's own.
ProtectHome=tmpfs
BindPaths=/home/omniralph
ProtectSystem=strict
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
UMask=0077

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now omniralph-agent
journalctl -u omniralph-agent -f          # pino JSON logs
curl -s http://127.0.0.1:9310/healthz      # {"status":"ok","connected":true,…}
```

Notes on the unit:

- `ProtectHome=tmpfs` + `BindPaths=` is the tuned form: `ProtectHome=yes` or `read-only` would stop
  the agent from writing its config (token rotation), repo cache and Claude session files. If the
  agent's home is elsewhere (e.g. `/home/coder`, or under `/home/coder/...` on Coder), bind that
  path instead.
- Node and git must come from outside `/home` (`/usr/bin`, `/usr/local/bin`) or from the agent's
  own home, because every other home is hidden.
- `ProtectSystem=strict` makes the rest of the file system read-only; the agent only writes in its
  home and `/tmp` (private).
- `StartLimit*` stops the restart loop when the agent exits because it has to be re-enrolled.

### Self-update (pm2)

An agent running under pm2 (detected by the `pm_id` variable pm2 sets) updates itself to the
**desired version**, so upgrades need no SSH:

1. When the heartbeat's desired version differs from the running one and isn't in the agent's
   failed list, the agent stops taking new jobs and lets running ones finish, for up to 2 hours.
   Heartbeats go on meanwhile (jobs keep their tokens and Linear replies). Jobs still running after
   2 hours are aborted; their queue messages aren't acknowledged, so they're redelivered.
2. It runs `npm i -g @omniralph/agent@<version>` as the agent's user, like the
   [install](#2-install) (the package is public, so no npm auth is needed).
3. It writes `update-state.json` next to `agent.json` (mode 0600):
   `{ previous, pending, startsSincePending, failed, lastError, handledRequestId }`.
4. It exits with code 0 and pm2 starts the new version.

If the install fails, the version is added to `failed` and the agent keeps running (and taking jobs
on) the current version.

**Rollback.** Each start with a `pending` version counts in `startsSincePending`. Once the new version
has heartbeated successfully for 60 seconds it's confirmed (`pending` is cleared). If it starts a
fourth time without that (it crashes, or can't reach the control panel), the agent reinstalls
`previous`, adds the pending version to `failed` and exits, so pm2 starts the previous version.
Failed versions are reported in the heartbeat, shown on the agent's page and never retried by that
agent on its own; to try one again after fixing the host, [trigger an update](#triggering-an-update). With `--max-restarts 5`, pm2 still allows the four starts a rollback
needs.

**Choosing the version.**

- **Settings › Agents** (admins) holds the organization's desired version (it applies to the
  organization's agents only), e.g. `1.4.0` (semver). Blank means
  versions aren't managed: agents keep whatever they run. **Use latest on npm** sets it to the
  package's `latest` dist-tag, read from the npm registry without a token (the package is public).
- **Agents › <agent> › Version** overrides it for one agent, e.g. to try a release on one host first
  or to pin a host to an older version. Clear the override to follow the organization's version again.
- To pin every agent, set the organization's version to an exact version and don't use **Use latest on
  npm**; agents never move on their own.

The **Agents** list and each agent's page show the reported version, the desired version, the
update status (**Up to date**, **Updating** with the step, **Failed** when the desired version
failed on that agent, **Update manually**) and the failed versions.

Agents not run by pm2 (systemd, tmux) report `selfUpdate: "unsupported"`, never install anything
and show **Update manually**: upgrade them by hand as in [Install](#2-install).

#### Triggering an update

An update can also be started on demand, from either side:

- **Agents › <agent> › Version › Update now** (admins; only for agents under pm2). The control panel
  sends an update request with every heartbeat until the agent reports it handled; meanwhile the
  agent shows **Updating** (*<version> requested*).
- `omniralph-agent update` on the host (as the agent's user, with the same `--config` as `start`).
  It writes `update-request.json` next to `agent.json` (mode 0600); the running agent picks it up
  with its next heartbeat and removes it. If the agent isn't running, it acts on it once started.

Either way the agent updates (drain, install, restart, rollback as above) to the desired version,
or to the package's `latest` on npm when none is chosen, and retries that version even if it's in
`failed` (it's taken off the list first). A request for the version already running does nothing.
Choosing a different version than the desired one isn't possible this way: the agent would
update back to the desired version straight away, so change the desired version instead. Agents
not under pm2 only log the request and show it as the last update error.

## Central config

Everything except the four local settings is configured centrally and delivered in every heartbeat
response (every 20s), so changes need no restart:

| Setting | Where | Default |
| -- | -- | -- |
| Max concurrency (parallel jobs) | **Agents › <agent>** | 1 |
| Concurrency per capability (1 to max concurrency) | **Agents › <agent>** | `ralph`: max concurrency − 1 (at least 1); others: max concurrency |
| Poll interval | **Agents › <agent>** | 5s |
| Enabled capabilities (`review`, `ralph`) | **Agents › <agent>** | `review` |
| Pinned repositories | **Agents › <agent>**, or **Repository › Settings › Agents** | none (every agent is eligible for every repo) |
| Desired agent version ([self-update](#self-update-pm2), pm2 only) | **Settings › Agents**; per-agent override on **Agents › <agent>** | none (not managed) |
| Job cancellations | **Jobs** (cancel) | — |

Per-capability limits cap how many of an agent's slots one capability's jobs may take. A worker only
receives from a capability's topics while that capability is under its limit, so with the default an
agent with two or more slots always keeps one free for reviews while hours-long ralph stories run.
Lowering a limit cancels nothing: the agent just takes no new jobs of that capability until it is
under the new limit. The heartbeat's `freeSlots` counts only slots some enabled capability could use.

Pinning a repository to an agent routes its jobs to that agent only and makes the agent pre-clone it
(`repo.sync`). The **Agents** page shows each agent's last heartbeat, version, running jobs and its
audit log (enrollment, token refreshes, credential issuance, revocation).

## Ralph

The `ralph` capability builds delegated Linear issues story by story (see [linear.md](linear.md)
for the Linear side and [ADR 0003](adr/0003-ralph-orchestration.md) for the design). An agent
runs five ralph job types: `ralph.story` (a Claude session, the quality gates, commit and push),
`ralph.describe-pr` (a read-only session writing the PR/MR description), `ralph.prepare` (a
manual story's approved preparation commands), `ralph.request` (one Claude session for an
@mention, a reply, review findings or a failed CI run, on the run's branch) and `ralph.cleanup`
(removes a merged PR/MR's worktree and local branch, no session). Running `ralph.story` and
`ralph.request` sessions also take Linear replies live: the heartbeat response carries them
(`jobMessages`) and the agent acknowledges them in its next heartbeat. Jobs download the run's
Linear attachments through the control panel and cache them in `<workspaceRoot>/.attachments/`.

### Enabling the capability

New agents only run reviews. To let an agent run ralph jobs, open **Agents › <agent>**, tick
`ralph` under **Enabled capabilities** and save; it applies with the next heartbeat (no restart).
The agent then also polls its organization's `ralph-jobs-org-<orgId>` topic and its own
`ralph-jobs-agent-<id>` topic (see [ADR 0004](adr/0004-organizations.md#per-organization-topics)).

- A run sticks to the agent that started it: all its later jobs go to that agent's topic, so keep
  `ralph` enabled on it until its runs finish. If you disable `ralph` on it or revoke it, the run's
  next job goes to any ralph-enabled agent, which recreates the branch worktree from the pushed
  branch.
- A repository pinned to agents (**Repository › Settings › Agents**) starts its runs on a pinned
  agent, so at least one of them needs `ralph` enabled, or the run's jobs are never picked up.
- Ralph sessions are long and write code: give ralph agents their own host (or keep **Max
  concurrency** at 1) if you also develop on it.

### Host prerequisites

Unlike reviews, ralph sessions run the repository's own tools, with full permissions
(`bypassPermissions`) inside the branch worktree, as the agent's user:

- **A git identity for commits.** Story commits use the agent user's git identity. Set one, as the
  agent's user, if it has none yet:

  ```sh
  git config --global user.name "Omniralph"
  git config --global user.email "omniralph@example.com"   # e.g. an address the code host links to the bot
  ```

  Without one, commits are made as `Omniralph <omniralph@localhost>`. Running as your workspace
  user, that's your own global identity, so story commits are made as you; use a dedicated user if
  they should carry a separate one. With systemd's `ProtectHome=tmpfs`, `~/.gitconfig` must be in
  the bound home.
- **The target repositories' toolchains.** The PRD's quality gates (`pnpm typecheck`, `cargo test`,
  …) and the repository's **Setup command** run on the host, so everything they need must be
  installed for the agent's user and on the unit's `PATH`: Node/pnpm (e.g. `corepack enable` as the
  agent's user), language runtimes, compilers, Docker if tests use Testcontainers (add the user to
  the `docker` group), and anything else the gates call. The systemd hardening above
  (`ProtectSystem=strict`, `PrivateTmp`, `ProtectHome=tmpfs`) applies to them too: tools that
  write outside the agent's home and `/tmp` need extra `ReadWritePaths=`. A gate that can't run fails every attempt.
- **Package registry access.** Private registries the setup command installs from need their
  credentials in the agent user's home (e.g. `~/.npmrc`). Running as your workspace user, your
  existing credentials are used; a dedicated user needs its own.
- **No `gh` or `glab` login.** The agent never uses code-host CLIs or API tokens. It pushes with
  the brokered, job-scoped `git-credential` helper (a write token for that one repository, only for
  running `ralph` jobs), and the control panel opens and updates the PR/MR itself. Sessions can
  use any `gh`/`glab` login, SSH key or API token the agent's user has. Running as your workspace
  user, that includes yours: if ralph sessions shouldn't be able to act as you on the code host,
  log out of them on that workspace or use a dedicated user.

Claude Code sessions in a ralph job load the agent user's `~/.claude/` settings, skills and
`CLAUDE.md` plus the repository's `.claude/` settings and `CLAUDE.md`
(`settingSources: ["user", "project", "local"]`) like a local session would, but they never see the job
token, so they can't fetch credentials themselves; only the job's own git commands can.

### Branch worktrees

Ralph jobs work in long-lived **branch worktrees** at
`<workspaceRoot>/.branches/<provider>/<host>/<repo path>/<branch with / replaced by __>`. A worktree is
created from the remote branch if it exists (otherwise from `origin/<base>`), runs the setup
command once, is reused by every job of the run and is locked while a job uses it. Uncommitted
leftovers of a failed attempt are stashed (labelled `omniralph ralph <run> <story> …`) and offered
to the next attempt.

Every branch worktree gets a `pre-push` hook that rejects pushes to any branch but its own (a
guardrail against mistakes, not a security boundary).

After the run's PR/MR merges, a `ralph.cleanup` job on the run's agent removes the branch worktree
and deletes the local branch (keeping a branch with unmerged commits until someone answers in
Linear); see [linear.md](linear.md#reviews-and-bot-requests-on-ralph-prsmrs). Worktrees of PRs/MRs
closed without merging, of repositories with **Clean up after the merge** off, and of an agent that
was revoked stay: delete `<workspaceRoot>/.branches/<provider>/<host>/<repo path>/<branch>` while
the agent isn't running a job for it, then
`git -C <workspaceRoot>/<provider>/<host>/<repo path> worktree prune`.

## `workspaceRoot` and disk usage

- Repositories are cached as **blobless bare clones** in
  `<workspaceRoot>/<provider>/<host>/<repo path>` (default `~/.omniralph/repos`), cloned on the
  first job and fetched afterwards. `<host>` is the clone URL's host (with its port, if any), so
  connections to different instances (e.g. github.com and a GitHub Enterprise Server) never share
  a directory. Blobless clones hold all commits and trees but only the blobs that were checked
  out, so they grow with use.
- Agents from before the host was part of the path cached repositories in
  `<workspaceRoot>/<provider>/<repo path>`: on startup, the agent moves each of them (and its branch
  worktrees under `.branches/`) to the new path, using the host of the repository's `origin` URL. A
  repository that can't be moved (e.g. its new path is taken) is left alone, logged, and cloned
  again at its new path; delete the old directory once nothing needs it.
- Each job checks out a **git worktree** in `<repo>/.worktrees/<jobId>`, removed when the job ends
  and pruned on startup after a crash. Peak usage is roughly the cached clones plus one full
  checkout per concurrently running job.
- Ralph runs also keep one **branch worktree** per run under `<workspaceRoot>/.branches/`,
  including whatever the setup command installs (e.g. `node_modules`). They're removed after the
  PR/MR merges; see [Branch worktrees](#branch-worktrees). Linear attachments are cached in
  `<workspaceRoot>/.attachments/<EPIC>/` and not evicted.
- Clone, fetch and worktree bookkeeping are serialized per repository with a lock file
  (`.locks/`), so two agent processes may share a workspace root, but don't point a manual checkout
  at it.
- There's no automatic eviction yet. To reclaim space, stop the agent and delete a repository's
  directory (it's re-cloned on the next job), or the whole workspace root.
- Rough sizing: the sum of your repositories' blobless clone sizes, plus `max concurrency` × your
  largest checkout, plus headroom. Watch it with `du -sh ~/.omniralph/repos/*` as the agent's user.

## Coexisting with cyralph

Moving from cyralph to Omniralph, and running both while you do, is covered step by step in
[cutover-from-cyralph.md](cutover-from-cyralph.md). In short: never route the same Linear team,
project or label in both, and don't point the agent's `--workspace-root` at cyralph's directories.

## Coexisting with manual dev work

- **Separate workspace root.** The agent's cache lives in the agent user's `~/.omniralph/repos`,
  separate from your manual checkouts, even when the agent runs as you. Never point `--workspace-root` at a directory you work in:
  worktrees there get pruned and repos fetched under you.
- **Separate credentials.** Job git commands reset `credential.helper` and use
  `omniralph-agent git-credential` (brokered, one repository, short-lived; read-only except for
  running `ralph` jobs), never your `gh`/`glab` logins or SSH keys. Ralph sessions run as the
  agent's user, though, so when that's you they could use those credentials themselves (see
  [Host prerequisites](#host-prerequisites)); a dedicated user makes the separation structural,
  since it can't read `/home/coder`.
- **Separate worktrees.** Don't work on a branch Omniralph is building from a manual checkout: the
  next story's push would be rejected as diverged. Ask for changes with an @mention or a reply
  instead.
- **Shared Claude rate limits.** If the agent's user is logged in to the same Claude subscription as
  you, you share its rate limits. The agent backs off and retries on rate limits instead of failing,
  but busy reviews still slow your sessions down. Lower the agent's max concurrency, or give it its
  own API key or subscription. See [claude-auth.md](claude-auth.md).
- **CPU and memory.** Each running job is a Claude Code process plus git. Keep max concurrency at 1
  or 2 on a workspace you also develop in.

## Re-enrollment (`refresh_reuse`, "re-enrollment required")

The agent exits with `omniralph-agent: re-enrollment required (…); run 'omniralph-agent enroll'
again` when the control panel rejects its refresh token:

- **`refresh_reuse`**: an already used refresh token was presented again. The control panel revoked
  the whole token family **and the agent**, and the agent's page shows a "Possible token theft"
  alert. Causes: the config file was copied to another host or restored from a backup, two
  processes ran with the same config, or the agent crashed between receiving and saving a rotated
  token.
- **Revoked**: an admin of its organization revoked the agent on the **Agents** page.

What to do:

1. Stop the agent (`sudo systemctl stop omniralph-agent`, or `pm2 stop omniralph-agent`) so it
   stops being restarted.
2. For `refresh_reuse`, find out why before re-enrolling: check the agent's audit log (the IP the
   reused token came from), whether another host or process uses a copy of `agent.json`, and
   delete any copies. If you can't explain it, treat the host as compromised: rotate the Claude
   credentials on it and check the agent user's files.
3. Enroll again with a new enrollment token from **Agents › Enroll agent** (in the same
   organization), as the agent's user. This
   creates a **new agent** (new ID) and overwrites `agent.json`; the revoked agent stays in the list
   for its history.
4. Re-apply the old agent's central config to the new one: max concurrency, poll interval,
   capabilities and **pinned repositories** (pins belong to the agent ID).
5. Start the agent again.

When an admin revokes an agent, its running jobs are re-queued at once. After a `refresh_reuse`, the
queue redelivers the agent's unfinished jobs once their leases lapse. Either way another agent (or
the newly enrolled one) picks them up.

## Troubleshooting

- **`agent.json is accessible by group or others`**: `chmod 600` it (and `chmod 700` its directory).
- **`agent.json not found`**: the agent runs as a different user or with a different `--config` /
  `OMNIRALPH_AGENT_CONFIG` than `enroll` used.
- **`/healthz` says `"connected": false`**: the control panel is unreachable or rejected the access
  token. Check the logs for the HTTP status.
- **Ralph stories fail every attempt on a quality gate** with `command not found` or similar: the
  gate's toolchain isn't installed for the agent's user or isn't on the unit's `PATH`
  ([Host prerequisites](#host-prerequisites)).
- **Ralph jobs stay queued**: no agent has `ralph` enabled, or the run's sticky (or pinned) agent is
  offline. Check **Jobs** for the job's topic.
- **Reviews fail with a Claude login message**: log in again as the agent's user
  ([claude-auth.md](claude-auth.md)).
