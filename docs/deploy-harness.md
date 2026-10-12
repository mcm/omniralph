# Deploying a harness

`omniralph-harness` is a Node 22 daemon that claims jobs from the control panel and runs them with
the Claude Agent SDK. It only makes **outbound HTTPS** calls: to the control panel (its harness API)
and to the code host (git clone/fetch with brokered, read-only tokens; `ralph` jobs also
push with brokered write tokens). It opens no port except an optional `/healthz` on `127.0.0.1`.

This guide sets one up on a Coder workspace, running as the **workspace user** (`coder`): the
harness's config, repo cache and Claude login live in that user's home, which the workspace persists.
On a dedicated or shared server you may want a **dedicated Unix user** instead, to keep the
harness's refresh token and Claude login away from other sessions on the host (see
[Optional: a dedicated user](#optional-a-dedicated-user)). The rest of this guide calls whichever
user runs the harness *the harness's user*.

## Prerequisites

- Node 22 (≥ 22.12) on the harness user's `PATH`. On Coder the workspace's Node (system-wide or
  nvm) is fine. For a dedicated user or a systemd unit, install it system-wide (e.g.
  `/usr/bin/node`): a Node installed with nvm under `/home/coder` isn't visible to other users.
- git ≥ 2.40 (2.44+ recommended: older versions lazily fetch commits while checking whether they're
  cached).
- `sudo` on the host only if you create a dedicated user or install a systemd unit.
- An admin account in the control panel organization the harness should serve.
- For ralph (`coding` tasks), also a git identity and the target repositories' toolchains: see
  [Ralph](#ralph).

### Coder specifics

- Coder workspaces usually persist only the workspace user's home volume (`/home/coder`). Running
  as `coder` keeps the harness's config (`~/.config/omniralph/`), repo cache (`~/.omniralph/repos`)
  and Claude login across rebuilds and restarts.
- `/etc/systemd/system` and anything outside `/home/coder` (including users created with
  `useradd`) are lost when the workspace is rebuilt, and for container templates on every restart.
  Container-based workspaces often have no systemd at all: use pm2 or tmux there (see below), started
  from the template's startup script.
- The harness is identified by its config file, not by the machine. A rebuilt workspace that kept the
  harness's home keeps working; one that lost it has to be enrolled again.

## 1. Choose the harness's user

On a Coder workspace, run the harness as the workspace user: there's nothing to create, and
everything it writes stays on the persistent home volume. The config file is mode 0600 (the harness
refuses to start if group or others can read it).

Running as your own user means the harness's sessions can reach whatever that user can: your files,
and any `gh`/`glab` logins, SSH keys and registry credentials in your home. Review sessions are
read-only, but ralph sessions run commands with full permissions in their worktree (see
[Host prerequisites](#host-prerequisites)). If that matters on the workspace, use a dedicated user.

### Optional: a dedicated user

On a dedicated server (or a host shared with other people or tools), run the harness as its own
Unix user:

```sh
sudo useradd --system --create-home --home-dir /home/omniralph --shell /bin/bash omniralph
sudo chmod 700 /home/omniralph
sudo -iu omniralph                                # run the steps below as this user
```

The home is 0700 and the config file 0600, so other users and their shells can't read
`~omniralph/.config/omniralph/harness.json` or the harness's Claude login, and the harness can't read
their homes. This separation protects against accidental and tool-driven access (a prompt-injected
session reading files it shouldn't). A user with passwordless `sudo` can still become `omniralph`;
remove that if you need a hard boundary.

On Coder, a dedicated user doesn't survive a rebuild: re-create it (and any unit) from the
template's startup script and keep its home on persistent storage (e.g.
`useradd --home-dir /home/coder/.omniralph-harness/home …`, mode 0700).

## 2. Install

The harness is published as the public npm package `@omniralph/harness`; installing it needs no npm
token. As the harness's user:

```sh
npm config set prefix ~/.local                    # global installs go to ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"              # also add this to ~/.profile
npm install -g @omniralph/harness
omniralph-harness --version
```

If the user's npm already installs global packages somewhere it can write (e.g. an nvm-managed
Node), skip the `prefix` line.

To upgrade by hand: stop the harness, run `npm install -g @omniralph/harness@latest`,
then start it again. Harnesses run under pm2 can update themselves instead (see
[Self-update](#self-update-pm2)). See [apps/harness/README.md](../apps/harness/README.md) for the release procedure.

Hosts that run 0.8.0 or earlier were installed under the old "agent" names and can't self-update
across the rename: reinstall them once as in
[Reinstalling a host after the rename](#reinstalling-a-host-after-the-rename).

### Reinstalling a host after the rename

Up to 0.8.0 the harness was published under "agent" names: the package, the binary, the pm2
process and the config-path variable said `agent` where they now say `harness`, and the config file
was `~/.config/omniralph/agent.json`. From 0.9.0 it's `@omniralph/harness`, the `omniralph-harness`
binary, `~/.config/omniralph/harness.json` and `OMNIRALPH_HARNESS_CONFIG`. A running harness
can't update itself across the rename, so reinstall each host by hand once, as the harness's user:

1. Stop the old daemon so it stops being restarted: `pm2 delete <name>` (`pm2 ls` shows the old
   process), `sudo systemctl disable --now <unit>`, or `Ctrl-c` in its tmux session.
2. Uninstall the old package: `npm ls -g --depth=0` lists it (the `@omniralph` package that isn't
   `harness`); remove it with `npm uninstall -g <that package>`. Hosts on 0.3.0 or earlier have
   the even older `@iamthemcmaster` package instead; remove that one the same way.
3. Install the new one: `npm install -g @omniralph/harness@latest`, then `omniralph-harness --version`.
4. Keep the harness's identity, or start afresh:
   - **Keep it**: move the config, which keeps the harness ID, its central config, pins and audit
     log: `mv ~/.config/omniralph/agent.json ~/.config/omniralph/harness.json` (the
     `update-state.json` and `update-request.json` files next to it can stay). If you passed
     `--config <file>`, keep passing it; if you set the old config variable, set
     `OMNIRALPH_HARNESS_CONFIG` instead. Don't start the old daemon again afterwards: two
     processes with one refresh token revoke the harness (see [Re-enrollment](#re-enrollment-refresh_reuse-re-enrollment-required)).
   - **Re-enroll**: [enroll](#4-enroll) with a new token from **Harnesses › Enroll harness**,
     delete the old config, and revoke the old entry on the **Harnesses** page.
5. Start it again with the new binary: for pm2, the [pm2 start command](#pm2) with
   `--name omniralph-harness` (then `pm2 save`); for systemd, rename the unit to
   `omniralph-harness.service` and point `ExecStart=` at
   `…/node_modules/@omniralph/harness/dist/cli.js` ([systemd](#systemd)); for tmux, the
   [tmux commands](#tmux). Update the Coder template's startup script to match.
6. Check that `curl -s http://127.0.0.1:9310/healthz` says `"connected": true` and that the
   **Harnesses** page shows the new version after the next heartbeat.

Self-update works again from then on.

## 3. Log the harness's user in to Claude

As the harness's user:

```sh
curl -fsSL https://claude.ai/install.sh | bash    # installs claude to ~/.local/bin, if not installed yet
claude                                            # log in, then /exit
claude -p "say ok"                                # works non-interactively
```

The Agent SDK bundles Claude Code and uses this login. On a Coder workspace where you already use
`claude`, the harness uses your existing login (and shares its rate limits). Alternatively set
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the harness's environment. See
[claude-auth.md](claude-auth.md), including the note on Anthropic's terms for subscription auth.

## 4. Enroll

Harnesses belong to an **organization**: the one active when the enrollment token was created. An
harness only receives, and only gets credentials for, that organization's jobs, and only its members
see it. To serve several organizations from one host, enroll one harness per organization (each with
its own `--config` and `--workspace-root`, or as its own user).

As an admin of that organization, open **Harnesses › Enroll harness** in the control panel. It shows a one-time command with
an enrollment token (single use, valid for 1 hour). Run it as the harness's user:

```sh
omniralph-harness enroll --server https://omniralph.example.com --token <enrollment-token> \
  --name coder-dev-1 --workspace-root ~/.omniralph/repos
```

`--name` defaults to the hostname and `--workspace-root` to `~/.omniralph/repos`.

This writes `~/.config/omniralph/harness.json` (mode 0600, directory 0700) with the server URL, harness
ID, refresh token and `workspaceRoot`. `--config <file>` or `OMNIRALPH_HARNESS_CONFIG` choose
another path, for `enroll` and `start` alike.

You can add these optional keys by hand. Token rotation keeps them, and they stay out of the file
when unset:

| Key | Default | Meaning |
| -- | -- | -- |
| `installables.allow` | `["@omniralph/*"]` | npm package patterns the harness accepts installables from. A pattern is an exact package name or contains `*`, which matches any characters except `/`: `@omniralph/*` matches `@omniralph/codegraph` but not `@omniralph-evil/x`. `[]` allows none. The harness enforces this itself, whatever the control panel asks. |
| `blockedExecPaths` | `[]` | Absolute path prefixes the harness never executes: host tools (whether their path was configured in the control panel or discovered on `PATH`), installable commands and installable MCP servers. Matches whole path segments (`/opt/x` covers `/opt/x/bin/tool`, not `/opt/xy`) after resolving symlinks on both sides. |
| `dataDir` | `~/.omniralph` | Absolute directory for the harness's installables and their caches. |

```json
{
  "server": "https://omniralph.example.com",
  "agentId": "…",
  "refreshToken": "…",
  "workspaceRoot": "/home/coder/.omniralph/repos",
  "installables": { "allow": ["@omniralph/*", "@acme/*"] },
  "blockedExecPaths": ["/opt/untrusted"]
}
```

[installables.md](installables.md) explains installables, host tools and how these keys lock a
host down. An invalid value stops the harness at startup with an error naming the key. Edit the file while the
harness is stopped: it rewrites the file when it rotates its refresh token, and a re-enrollment
replaces it.

The refresh token rotates every ~15 minutes and is rewritten atomically. **Never copy the file to
another host or restore an old backup of it**: presenting an old refresh token looks like token
theft and revokes the harness (see *Re-enrollment*). To run another harness, enroll it separately.

## 5. Run it

On a Coder workspace, use pm2 (restarts on exit, [self-updates](#self-update-pm2)) or tmux,
started from the template's startup script. Use systemd on hosts that have it, typically with a
dedicated user.

### pm2

pm2 restarts the harness when it exits and keeps its logs. Install it as the harness's user
(`npm install -g pm2`), enroll first (`start` exits at once without `harness.json`), then, as the
harness's user:

```sh
pm2 start "$(command -v omniralph-harness)" --name omniralph-harness \
  --kill-timeout 90000 --restart-delay 30000 --max-restarts 5 \
  -- start --healthz-port 9310
pm2 save                                   # remember it for `pm2 resurrect`
pm2 logs omniralph-harness                   # pino JSON logs
curl -s http://127.0.0.1:9310/healthz      # {"status":"ok","connected":true,…}
```

- `--kill-timeout 90000`: pm2 sends SIGINT (handled like SIGTERM) and by default kills the process
  after 1.6s. The harness gives running jobs up to 60s, so allow 90s.
- `--restart-delay 30000`: wait 30s between restarts, so a crashing harness doesn't hammer the
  control panel.
- `--max-restarts 5`: pm2 only counts restarts within `min_uptime` (default 1s; the CLI has no flag
  for it). A "re-enrollment required" exit can take longer than that, so pm2 may keep restarting
  the harness every 30s. That's harmless, but stop it (`pm2 stop omniralph-harness`) before enrolling
  again.
- After a reboot or workspace restart, run `pm2 resurrect`: put it in the Coder template's startup
  script. On hosts with systemd, `pm2 startup` can do this instead.
- pm2 captures the environment when the process is first started. After changing
  `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or `OMNIRALPH_LOG_LEVEL`, run
  `pm2 restart omniralph-harness --update-env`.
- To upgrade: choose a version on **Settings › Harnesses** and the harness updates itself (see below),
  or trigger an update with **Update now** on the harness's page or `omniralph-harness update` on the
  host ([Triggering an update](#triggering-an-update)). By hand: `npm install -g @omniralph/harness@latest && pm2 restart omniralph-harness`.
- Don't pass `--stop-exit-codes 0` or `--no-autorestart`: the harness exits with code 0 after a
  self-update and relies on pm2 to start it again.

### tmux

As the harness's user:

```sh
tmux new-session -d -s omniralph-harness \
  'omniralph-harness start --healthz-port 9310 2>&1 | tee -a ~/harness.log'
tmux attach -t omniralph-harness             # Ctrl-b d to detach
```

tmux doesn't restart the harness when it exits, and doesn't start it after a reboot or workspace
restart: put the first command in the Coder template's startup script. Stop it with `Ctrl-c` in the
session (SIGINT is handled like SIGTERM). With a dedicated user, prefix both commands with
`sudo -iu omniralph`.

### systemd

On hosts with systemd, a unit restarts the harness and starts it at boot. This example runs it as
the dedicated `omniralph` user from [Optional: a dedicated user](#optional-a-dedicated-user); for
another user, change `User=`, `Group=` and the `/home/omniralph` paths.

`/etc/systemd/system/omniralph-harness.service`:

```ini
[Unit]
Description=Omniralph harness
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
EnvironmentFile=-/etc/omniralph/harness.env
ExecStart=/usr/bin/node /home/omniralph/.local/lib/node_modules/@omniralph/harness/dist/cli.js start --healthz-port 9310
# SIGTERM: stop claiming, give running jobs up to 60s; unfinished jobs are redelivered.
KillSignal=SIGTERM
TimeoutStopSec=90
Restart=on-failure
RestartSec=30

# Hardening
NoNewPrivileges=yes
# Hide every home directory (incl. /home/coder and /root), then expose only the harness's own.
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
sudo systemctl enable --now omniralph-harness
journalctl -u omniralph-harness -f          # pino JSON logs
curl -s http://127.0.0.1:9310/healthz      # {"status":"ok","connected":true,…}
```

Notes on the unit:

- `ProtectHome=tmpfs` + `BindPaths=` is the tuned form: `ProtectHome=yes` or `read-only` would stop
  the harness from writing its config (token rotation), repo cache and Claude session files. If the
  harness's home is elsewhere (e.g. `/home/coder`, or under `/home/coder/...` on Coder), bind that
  path instead.
- Node and git must come from outside `/home` (`/usr/bin`, `/usr/local/bin`) or from the harness's
  own home, because every other home is hidden.
- `ProtectSystem=strict` makes the rest of the file system read-only; the harness only writes in its
  home and `/tmp` (private).
- `StartLimit*` stops the restart loop when the harness exits because it has to be re-enrolled.

### Self-update (pm2)

A harness running under pm2 (detected by the `pm_id` variable pm2 sets) updates itself to the
**desired version**, so upgrades need no SSH:

1. When the heartbeat's desired version differs from the running one and isn't in the harness's
   failed list, the harness stops taking new jobs and lets running ones finish, for up to 2 hours.
   Heartbeats go on meanwhile (jobs keep their tokens and Linear replies). Jobs still running after
   2 hours are aborted; their leases lapse, so they're redelivered.
2. It runs `npm i -g @omniralph/harness@<version>` as the harness's user, like the
   [install](#2-install) (the package is public, so no npm auth is needed).
3. It writes `update-state.json` next to `harness.json` (mode 0600):
   `{ previous, pending, startsSincePending, failed, lastError, handledRequestId }`.
4. It exits with code 0 and pm2 starts the new version.

If the install fails, the version is added to `failed` and the harness keeps running (and taking jobs
on) the current version.

**Rollback.** Each start with a `pending` version counts in `startsSincePending`. Once the new version
has heartbeated successfully for 60 seconds it's confirmed (`pending` is cleared). If it starts a
fourth time without that (it crashes, or can't reach the control panel), the harness reinstalls
`previous`, adds the pending version to `failed` and exits, so pm2 starts the previous version.
Failed versions are reported in the heartbeat, shown on the harness's page and never retried by that
harness on its own; to try one again after fixing the host, [trigger an update](#triggering-an-update). With `--max-restarts 5`, pm2 still allows the four starts a rollback
needs.

**Choosing the version.**

- **Settings › Harnesses** (admins) holds the organization's desired version (it applies to the
  organization's harnesses only), e.g. `1.4.0` (semver), or `latest`. Blank means
  versions aren't managed: harnesses keep whatever they run.
- `latest` (**Track latest on npm**) follows the package's `latest` dist-tag, so harnesses update with
  each release. The control panel reads it from the npm registry without a token (the package is
  public) and keeps it in the database, reading it again once it's 5 minutes old; every heartbeat
  then hands out that version. If the registry can't be read, harnesses get the last version read
  (none before the first read: they stay where they are) and the error shows on Settings › Harnesses.
  **Update now** reads npm at once and records that version too.
- **Harnesses › <harness> › Version** overrides it for one harness, e.g. to try a release on one host first
  or to pin a host to an older version. Clear the override to follow the organization's version again.
- To pin every harness, set the organization's version to an exact version instead of `latest`;
  harnesses never move on their own.

The **Harnesses** list and each harness's page show the reported version, the desired version, the
update status (**Up to date**, **Updating** with the step, **Failed** when the desired version
failed on that harness, **Update manually**) and the failed versions.

Harnesses not run by pm2 (systemd, tmux) report `selfUpdate: "unsupported"`, never install anything
and show **Update manually**: upgrade them by hand as in [Install](#2-install).

#### Triggering an update

An update can also be started on demand, from either side:

- **Harnesses › <harness> › Version › Update now** (admins; only for harnesses under pm2). The control panel
  sends an update request with every heartbeat until the harness reports it handled; meanwhile the
  harness shows **Updating** (*<version> requested*).
- `omniralph-harness update` on the host (as the harness's user, with the same `--config` as `start`).
  It writes `update-request.json` next to `harness.json` (mode 0600); the running harness picks it up
  with its next heartbeat and removes it. If the harness isn't running, it acts on it once started.

Either way the harness updates (drain, install, restart, rollback as above) to the desired version,
or to the package's `latest` on npm when none is chosen or the organization tracks `latest`, and retries that version even if it's in
`failed` (it's taken off the list first). A request for the version already running does nothing.
Choosing a different version than the desired one isn't possible this way: the harness would
update back to the desired version straight away, so change the desired version instead. Harnesses
not under pm2 only log the request and show it as the last update error.

## Central config

Everything except the four local settings is configured centrally and delivered in every heartbeat
response (every 20s), so changes need no restart:

| Setting | Where | Default |
| -- | -- | -- |
| Max concurrency (parallel jobs) | **Harnesses › <harness>** | 1 |
| Concurrency per pool (1 to max concurrency) | **Harnesses › <harness>** | `long`: max concurrency − 1 (at least 1); `short`: max concurrency |
| Accepted task types (`query`, `review`, `coding`) | **Harnesses › <harness>** | `query`, `review` |
| Pinned repositories | **Harnesses › <harness>**, or **Repository › Settings › Harness pinning** | none (every harness is eligible for every repo) |
| Desired harness version ([self-update](#self-update-pm2), pm2 only) | **Settings › Harnesses**; per-harness override on **Harnesses › <harness>** | none (not managed) |
| Job cancellations | **Jobs** (cancel) | — |

Accepted task types decide what a host may run (trust): `query` (replies, code questions, learned
rules, triage), `review` (PR/MR reviews) and `coding` (ralph jobs, which change code and push).
`repo.sync` and other housekeeping jobs always run. Pool limits decide how many of a harness's
slots one pool's jobs may take (concurrency): `short` holds query and review jobs, `long` coding
jobs. The harness only claims a pool's jobs while that pool is under its limit, so with the default a
harness with two or more slots always keeps one free for reviews while hours-long ralph stories run.
Lowering a limit cancels nothing: the harness just takes no new jobs of that pool until it is
under the new limit.

Accepted task types and pool limits replace the former capabilities (`review`, `ralph`, `triage`)
and their concurrency caps. Query tasks (replies, code questions, learned rules, triage) are
only claimed by harnesses on 0.9.0 or later, and reviews (`review.task` jobs, one per review task
the repository enables) and tasks with setup commands only by harnesses on 0.10.0 or later, and
coding runs (a repository on the **Coding tasks** path) only by harnesses on 0.11.0 or later (the
jobs' `min_harness_version`); older harnesses leave them queued. The control panel sends each job's
prompt, tools and model with the job (its run spec), so changing a task needs no harness release.
A task's setup and teardown commands (e.g. Semgrep feeding a review) run on the host, in the job's
worktree, with whatever is on the harness's `PATH` and without the job tokens. See
[ADR 0008](adr/0008-agents-tasks-and-the-harness.md) for task types, pools, run specs and review
runs.

Pinning a repository to a harness routes its jobs to that harness only and makes the harness pre-clone it
(`repo.sync`). The **Harnesses** page shows each harness's last heartbeat, version, running jobs and its
audit log (enrollment, token refreshes, credential issuance, revocation).

## Ralph

Ralph builds delegated Linear issues story by story (see [linear.md](linear.md)
for the Linear side and [ADR 0003](adr/0003-ralph-orchestration.md) for the design). A harness
runs these jobs for a run: `ralph.story` (a Claude session, the quality gates, commit and push),
`ralph.request` (one Claude session for an @mention, a reply, review findings or a failed CI run,
on the run's branch), `ralph.describe-pr` (a read-only session writing the PR/MR description), and
the system RPCs `worktree.exec` (a manual story's approved preparation commands, no session) and
`worktree.cleanup` (removes a closed PR/MR's or stopped run's worktree, and after a merge the local
branch, no session). `ralph.prepare` and `ralph.cleanup` jobs queued before the upgrade still run.
Running `ralph.story` and `ralph.request` sessions also take Linear replies live: the heartbeat
response carries them (`jobMessages`) and the harness acknowledges them in its next heartbeat.
Jobs download the run's Linear attachments through the control panel and cache them in
`<workspaceRoot>/.attachments/`.

### Coding path: legacy jobs or coding tasks

**Repository › Settings › Ralph › Coding path** picks how a repository's runs work stories and
requests; it applies from the run's next job, and both paths share all run state:

- **Legacy jobs** (the default): `ralph.story`, `ralph.request` and `ralph.describe-pr` run the
  harness's built-in ralph code, with one job token that can push. A request session can push the
  branch by itself.
- **Coding tasks**: the same jobs are coding runs of the built-in tasks `builtin:implement-story`
  and `builtin:handle-request` (agent `builtin:engineer`), and the PR/MR description a query run
  of `builtin:describe-pr` (see
  [ADR 0008](adr/0008-agents-tasks-and-the-harness.md#coding-runs)). Only the harness's own git
  commands can push: the session's git gets a read-only credential, and a request session
  publishes its work by calling the `ship` tool, which makes the harness commit, push and return
  what happened. A story task that pushes only at the end pushes story commits to a hidden ref and
  the branch once, with a `ralph.push` job, before the PR/MR is described.

Coding runs are only claimed by harnesses on 0.11.0 or later; older ones leave them queued. A run
sticks to the harness that ran its first job, so update a repository's harnesses (its pinned ones,
or any accepting `coding`) before switching it to **Coding tasks**, or a run started on an older
one waits for it to update. The repository's ralph **Model** isn't applied to the description run
yet (it uses `opus`).

### Enabling ralph

New harnesses only run query and review tasks. To let a harness run ralph jobs, open **Harnesses ›
<harness>**, tick `coding` under **Accepted task types** and save; it applies with the next heartbeat
(no restart). The harness then also claims its organization's `ralph` jobs (`coding` task type,
`long` pool; see
[ADR 0004](adr/0004-organizations.md#job-isolation)).

- A run sticks to the harness that started it: all its later jobs are targeted at that harness, so keep
  `coding` accepted on it until its runs finish. If you untick `coding` on it or revoke it, the run's
  next job goes to any harness that accepts `coding`, which recreates the branch worktree from the pushed
  branch.
- A repository pinned to harnesses (**Repository › Settings › Harness pinning**) starts its runs on a pinned
  harness, so at least one of them needs to accept `coding`, or the run's jobs are never picked up.
- Ralph sessions are long and write code: give ralph harnesses their own host (or keep **Max
  concurrency** at 1) if you also develop on it.

### Host prerequisites

Unlike reviews, ralph sessions run the repository's own tools, with full permissions
(`bypassPermissions`) inside the branch worktree, as the harness's user:

- **A git identity for commits.** Story commits use the harness user's git identity. Set one, as the
  harness's user, if it has none yet:

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
  installed for the harness's user and on the unit's `PATH`: Node/pnpm (e.g. `corepack enable` as the
  harness's user), language runtimes, compilers, Docker if tests use Testcontainers (add the user to
  the `docker` group), and anything else the gates call. The systemd hardening above
  (`ProtectSystem=strict`, `PrivateTmp`, `ProtectHome=tmpfs`) applies to them too: tools that
  write outside the harness's home and `/tmp` need extra `ReadWritePaths=`. A gate that can't run fails every attempt.
- **Package registry access.** Private registries the setup command installs from need their
  credentials in the harness user's home (e.g. `~/.npmrc`). Running as your workspace user, your
  existing credentials are used; a dedicated user needs its own.
- **No `gh` or `glab` login.** The harness never uses code-host CLIs or API tokens. It pushes with
  the brokered, job-scoped `git-credential` helper (a write token for that one repository, only for
  a running coding run's lifecycle token, a legacy `ralph.*` job's token or a `worktree.cleanup`
  RPC), and the control panel opens and updates the PR/MR itself. Sessions can
  use any `gh`/`glab` login, SSH key or API token the harness's user has. Running as your workspace
  user, that includes yours: if ralph sessions shouldn't be able to act as you on the code host,
  log out of them on that workspace or use a dedicated user.

Claude Code sessions in a ralph job load the harness user's `~/.claude/` settings, skills and
`CLAUDE.md` plus the repository's `.claude/` settings and `CLAUDE.md`
(`settingSources: ["user", "project", "local"]`) like a local session would. On the **Coding tasks**
path their git credential helper uses the run's session token, which only ever gets a read
credential, so only the harness's own git commands (and `ship`) can push. On the legacy path a
story session never sees the job token, but a request session's git uses it and can push.

### Branch worktrees

Ralph jobs work in long-lived **branch worktrees** at
`<workspaceRoot>/.branches/<provider>/<host>/<repo path>/<branch with / replaced by __>`. A worktree is
created from the remote branch if it exists (otherwise from `origin/<base>`), runs the setup
command once, is reused by every job of the run and is locked while a job uses it. Uncommitted
leftovers of a failed attempt are stashed (labelled `omniralph ralph <run> <story> …`) and offered
to the next attempt.

Every branch worktree gets a `pre-push` hook that rejects pushes to any branch but its own (a
guardrail against mistakes, not a security boundary).

After the run's PR/MR merges, a `worktree.cleanup` system RPC on the run's harness removes the branch worktree
and deletes the local branch (keeping a branch with unmerged commits until someone answers in
Linear); see [linear.md](linear.md#reviews-and-bot-requests-on-ralph-prsmrs). After a PR/MR closes
without merging, or the run is stopped, the same RPC stashes uncommitted work and removes the
worktree but keeps the local branch (a resumed run recreates the worktree from it; a local branch
ahead of `origin` is never reset). Nothing deletes a branch on `origin`. A run whose story task
pushes only at the end keeps its story commits on a hidden ref (`refs/omniralph/runs/<run>`); once
the run completes or fails, a `worktree.cleanup` RPC with only those refs (on any harness, no repository
clone needed) deletes them on `origin` with git. The daily `prune-hidden-refs` cron catches missed
ones and deletes refs older than 14 days whose run isn't running (a stopped run keeps its ref until then). Worktrees of repositories
with **Clean up after the merge** off, and of a harness that was revoked stay: delete `<workspaceRoot>/.branches/<provider>/<host>/<repo path>/<branch>` while
the harness isn't running a job for it, then
`git -C <workspaceRoot>/<provider>/<host>/<repo path> worktree prune`.

## `workspaceRoot` and disk usage

- Repositories are cached as **blobless bare clones** in
  `<workspaceRoot>/<provider>/<host>/<repo path>` (default `~/.omniralph/repos`), cloned on the
  first job and fetched afterwards. `<host>` is the clone URL's host (with its port, if any), so
  connections to different instances (e.g. github.com and a GitHub Enterprise Server) never share
  a directory. Blobless clones hold all commits and trees but only the blobs that were checked
  out, so they grow with use.
- Harnesses from before the host was part of the path cached repositories in
  `<workspaceRoot>/<provider>/<repo path>`: on startup, the harness moves each of them (and its branch
  worktrees under `.branches/`) to the new path, using the host of the repository's `origin` URL. A
  repository that can't be moved (e.g. its new path is taken) is left alone, logged, and cloned
  again at its new path; delete the old directory once nothing needs it. A branch worktree that
  can't be moved stays at its old path, still linked to the moved repository.
- Each job checks out a **git worktree** in `<repo>/.worktrees/<jobId>`, removed when the job ends
  and pruned on startup after a crash. Peak usage is roughly the cached clones plus one full
  checkout per concurrently running job.
- Ralph runs also keep one **branch worktree** per run under `<workspaceRoot>/.branches/`,
  including whatever the setup command installs (e.g. `node_modules`). They're removed after the
  PR/MR merges; see [Branch worktrees](#branch-worktrees). Linear attachments are cached in
  `<workspaceRoot>/.attachments/<EPIC>/` and not evicted.
- Clone, fetch and worktree bookkeeping are serialized per repository with a lock file
  (`.locks/`), so two harness processes may share a workspace root, but don't point a manual checkout
  at it.
- There's no automatic eviction yet. To reclaim space, stop the harness and delete a repository's
  directory (it's re-cloned on the next job), or the whole workspace root.
- Rough sizing: the sum of your repositories' blobless clone sizes, plus `max concurrency` × your
  largest checkout, plus headroom. Watch it with `du -sh ~/.omniralph/repos/*` as the harness's user.

## Coexisting with cyralph

Moving from cyralph to Omniralph, and running both while you do, is covered step by step in
[cutover-from-cyralph.md](cutover-from-cyralph.md). In short: never route the same Linear team,
project or label in both, and don't point the harness's `--workspace-root` at cyralph's directories.

## Coexisting with manual dev work

- **Separate workspace root.** The harness's cache lives in the harness user's `~/.omniralph/repos`,
  separate from your manual checkouts, even when the harness runs as you. Never point `--workspace-root` at a directory you work in:
  worktrees there get pruned and repos fetched under you.
- **Separate credentials.** Job git commands reset `credential.helper` and use
  `omniralph-harness git-credential` (brokered, one repository, short-lived; read-only except for
  running `ralph` jobs), never your `gh`/`glab` logins or SSH keys. Ralph sessions run as the
  harness's user, though, so when that's you they could use those credentials themselves (see
  [Host prerequisites](#host-prerequisites)); a dedicated user makes the separation structural,
  since it can't read `/home/coder`.
- **Separate worktrees.** Don't work on a branch Omniralph is building from a manual checkout: the
  next story's push would be rejected as diverged. Ask for changes with an @mention or a reply
  instead.
- **Shared Claude rate limits.** If the harness's user is logged in to the same Claude subscription as
  you, you share its rate limits. The harness backs off and retries on rate limits instead of failing,
  but busy reviews still slow your sessions down. Lower the harness's max concurrency, or give it its
  own API key or subscription. See [claude-auth.md](claude-auth.md).
- **CPU and memory.** Each running job is a Claude Code process plus git. Keep max concurrency at 1
  or 2 on a workspace you also develop in.

## Re-enrollment (`refresh_reuse`, "re-enrollment required")

The harness exits with `omniralph-harness: re-enrollment required (…); run 'omniralph-harness enroll'
again` when the control panel rejects its refresh token:

- **`refresh_reuse`**: an already used refresh token was presented again. The control panel revoked
  the whole token family **and the harness**, and the harness's page shows a "Possible token theft"
  alert. Causes: the config file was copied to another host or restored from a backup, two
  processes ran with the same config, or the harness crashed between receiving and saving a rotated
  token.
- **Revoked**: an admin of its organization revoked the harness on the **Harnesses** page.

What to do:

1. Stop the harness (`sudo systemctl stop omniralph-harness`, or `pm2 stop omniralph-harness`) so it
   stops being restarted.
2. For `refresh_reuse`, find out why before re-enrolling: check the harness's audit log (the IP the
   reused token came from), whether another host or process uses a copy of `harness.json`, and
   delete any copies. If you can't explain it, treat the host as compromised: rotate the Claude
   credentials on it and check the harness user's files.
3. Enroll again with a new enrollment token from **Harnesses › Enroll harness** (in the same
   organization), as the harness's user. This
   creates a **new harness** (new ID) and overwrites `harness.json`; the revoked harness stays in the list
   for its history.
4. Re-apply the old harness's central config to the new one: max concurrency,
   accepted task types, pool limits and **pinned repositories** (pins belong to the harness ID).
5. Start the harness again.

When an admin revokes a harness, its running jobs are re-queued at once. After a `refresh_reuse`, the
harness's unfinished jobs are redelivered once their leases lapse (2 minutes without a heartbeat). Either way another harness (or
the newly enrolled one) picks them up.

## Troubleshooting

- **`harness.json is accessible by group or others`**: `chmod 600` it (and `chmod 700` its directory).
- **`harness.json not found`**: the harness runs as a different user or with a different `--config` /
  `OMNIRALPH_HARNESS_CONFIG` than `enroll` used.
- **`/healthz` says `"connected": false`**: the control panel is unreachable or rejected the access
  token. Check the logs for the HTTP status.
- **Ralph stories fail every attempt on a quality gate** with `command not found` or similar: the
  gate's toolchain isn't installed for the harness's user or isn't on the unit's `PATH`
  ([Host prerequisites](#host-prerequisites)).
- **Ralph jobs stay queued**: no harness accepts the `coding` task type, the run's sticky (or pinned) harness is
  offline, or (on the **Coding tasks** path) it runs a version older than 0.11.0. Check **Jobs** for the job's status.
- **Reviews stay queued**: no online harness accepts the `review` task type on version 0.10.0 or
  later (or, if the repository pins jobs to harnesses, none of the pinned ones). Update the harness
  ([self-update](#self-update-pm2) or `omniralph-harness update`).
- **Reviews fail with a Claude login message**: log in again as the harness's user
  ([claude-auth.md](claude-auth.md)).
