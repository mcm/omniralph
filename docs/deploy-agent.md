# Deploying an agent

`omniralph-agent` is a Node 22 daemon that pulls jobs through the control panel and runs them with
the Claude Agent SDK. It only makes **outbound HTTPS** calls: to the control panel (API and queue
proxy) and to the code host (git clone/fetch with brokered, read-only tokens; `ralph` jobs also
push with brokered write tokens). It opens no port except an optional `/healthz` on `127.0.0.1`.

This guide sets one up on a Coder instance, running as a **dedicated Unix user** so the agent's
refresh token and Claude login are kept away from your dev sessions and cyralph.

## Prerequisites

- Node 22 (≥ 22.12) installed system-wide (e.g. `/usr/bin/node`), so a dedicated user and systemd can
  use it. A Node installed with nvm under `/home/coder` won't be visible to the agent's user.
- git ≥ 2.40 (2.44+ recommended: older versions lazily fetch commits while checking whether they're
  cached).
- `sudo` on the instance (to create the user and install the unit).
- An admin account on the control panel.
- For the `ralph` capability, also a git identity and the target repositories' toolchains: see
  [Ralph](#ralph).

### Coder specifics

- Coder workspaces usually persist only the workspace user's home volume (`/home/coder`). A user
  created with `useradd`, `/etc/systemd/system` and `/home/omniralph` are lost when the workspace is
  rebuilt (and for container templates, on every restart). Either use a VM-based template, or
  re-create the user and unit from the template's startup script and keep the agent's home on
  persistent storage (e.g. `useradd --home-dir /home/coder/.omniralph-agent/home …`, mode 0700).
- Container-based workspaces often have no systemd. Use tmux there (see below).
- The agent is identified by its config file, not by the machine. A rebuilt workspace that kept the
  agent's home keeps working; one that lost it has to be enrolled again.

## 1. Create the agent's user

```sh
sudo useradd --system --create-home --home-dir /home/omniralph --shell /bin/bash omniralph
sudo chmod 700 /home/omniralph
```

The home is 0700 and the config file 0600 (the agent refuses to start if group or others can read
it), so cyralph, your dev sessions and their shells, which run as `coder`, can't read
`~omniralph/.config/omniralph/agent.json` or the agent's Claude login.

This separation protects against accidental and tool-driven access (a prompt-injected session
reading files it shouldn't). A user with passwordless `sudo` (the default `coder` user on many
templates) can still become `omniralph`; remove that if you need a hard boundary.

## 2. Install

The agent is published as the private npm package `@iamthemcmaster/omniralph-agent`. The agent's
user needs an `~/.npmrc` with a token that can read the `@iamthemcmaster` scope (a read-only
granular token is enough):

```sh
sudo -iu omniralph
echo "//registry.npmjs.org/:_authToken=<read-only npm token>" > ~/.npmrc && chmod 600 ~/.npmrc
npm config set prefix ~/.local                    # global installs go to ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"              # also add this to ~/.profile
npm install -g @iamthemcmaster/omniralph-agent
omniralph-agent --version
```

To upgrade: stop the agent, run `npm install -g @iamthemcmaster/omniralph-agent@latest`, then start
it again. See [apps/agent/README.md](../apps/agent/README.md) for the release procedure.

## 3. Give the agent's user its own Claude login

Still as `omniralph`:

```sh
curl -fsSL https://claude.ai/install.sh | bash    # installs claude to ~/.local/bin
claude                                            # log in, then /exit
claude -p "say ok"                                # works non-interactively
```

The Agent SDK bundles Claude Code and uses this login. Alternatively set `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN` in the unit's environment file. See [claude-auth.md](claude-auth.md),
including the note on Anthropic's terms for subscription auth.

## 4. Enroll

As an admin, open **Agents › Enroll agent** in the control panel. It shows a one-time command with
an enrollment token (single use, valid for 1 hour). Run it as `omniralph`:

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

### systemd (recommended)

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
ExecStart=/usr/bin/node /home/omniralph/.local/lib/node_modules/@iamthemcmaster/omniralph-agent/dist/cli.js start --healthz-port 9310
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
  the agent from writing its config (token rotation), repo cache and Claude session files. If you
  moved the agent's home (e.g. under `/home/coder/...` on Coder), bind that path instead.
- Node and git must come from outside `/home` (`/usr/bin`, `/usr/local/bin`) or from the agent's
  own home, because every other home is hidden.
- `ProtectSystem=strict` makes the rest of the file system read-only; the agent only writes in its
  home and `/tmp` (private).
- `StartLimit*` stops the restart loop when the agent exits because it has to be re-enrolled.

### tmux (no systemd)

```sh
sudo -iu omniralph tmux new-session -d -s omniralph-agent \
  'omniralph-agent start --healthz-port 9310 2>&1 | tee -a ~/agent.log'
sudo -iu omniralph tmux attach -t omniralph-agent      # Ctrl-b d to detach
```

tmux doesn't restart the agent when it exits, and doesn't start it after a reboot or workspace
restart: put the first command in the Coder template's startup script. Stop it with `Ctrl-c` in the
session (SIGINT is handled like SIGTERM).

### pm2 (no systemd)

pm2 restarts the agent when it exits and keeps its logs. Install it as the agent's user
(`npm install -g pm2`), enroll first (`start` exits at once without `agent.json`), then:

```sh
sudo -iu omniralph
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
- To upgrade: `npm install -g @iamthemcmaster/omniralph-agent@latest && pm2 restart omniralph-agent`.

## Central config

Everything except the four local settings is configured centrally and delivered in every heartbeat
response (every 20s), so changes need no restart:

| Setting | Where | Default |
| -- | -- | -- |
| Max concurrency (parallel jobs) | **Agents › <agent>** | 1 |
| Poll interval | **Agents › <agent>** | 5s |
| Enabled capabilities (`review`, `ralph`) | **Agents › <agent>** | `review` |
| Pinned repositories | **Agents › <agent>**, or **Repository › Settings › Agents** | none (every agent is eligible for every repo) |
| Job cancellations | **Jobs** (cancel) | — |

Pinning a repository to an agent routes its jobs to that agent only and makes the agent pre-clone it
(`repo.sync`). The **Agents** page shows each agent's last heartbeat, version, running jobs and its
audit log (enrollment, token refreshes, credential issuance, revocation).

## Ralph

The `ralph` capability builds delegated Linear issues story by story (see [linear.md](linear.md)
for the Linear side and [ADR 0003](adr/0003-ralph-orchestration.md) for the design). An agent
runs three ralph job types: `ralph.story` (a Claude session, the quality gates, commit and push),
`ralph.describe-pr` (a read-only session writing the PR/MR description) and `ralph.prepare` (a
manual story's approved preparation commands).

### Enabling the capability

New agents only run reviews. To let an agent run ralph jobs, open **Agents › <agent>**, tick
`ralph` under **Enabled capabilities** and save; it applies with the next heartbeat (no restart).
The agent then also polls the `ralph-jobs` topic and its own `ralph-jobs-agent-<id>` topic.

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
  agent's user:

  ```sh
  git config --global user.name "Omniralph"
  git config --global user.email "omniralph@example.com"   # e.g. an address the code host links to the bot
  ```

  Without one, commits are made as `Omniralph <omniralph@localhost>`. With systemd's
  `ProtectHome=tmpfs`, `~/.gitconfig` must be in the bound home (it is, at `/home/omniralph`).
- **The target repositories' toolchains.** The PRD's quality gates (`pnpm typecheck`, `cargo test`,
  …) and the repository's **Setup command** run on the host, so everything they need must be
  installed for the agent's user and on the unit's `PATH`: Node/pnpm (e.g. `corepack enable` as the
  agent's user), language runtimes, compilers, Docker if tests use Testcontainers (add the user to
  the `docker` group), and anything else the gates call. The systemd hardening above
  (`ProtectSystem=strict`, `PrivateTmp`, `ProtectHome=tmpfs`) applies to them too: tools that
  write outside the agent's home and `/tmp` need extra `ReadWritePaths=`. A gate that can't run fails every attempt.
- **Package registry access.** Private registries the setup command installs from need their
  credentials in the agent user's home (e.g. `~/.npmrc`), since the agent can't read yours.
- **No `gh` or `glab` login.** The agent never uses code-host CLIs or API tokens. It pushes with
  the brokered, job-scoped `git-credential` helper (a write token for that one repository, only for
  running `ralph` jobs), and the control panel opens and updates the PR/MR itself. Don't log the
  agent's user in to `gh`/`glab`: sessions would be able to use those credentials.

Claude Code sessions in a ralph job load the repository's `.claude/` settings and `CLAUDE.md`
(`settingSources: ["project", "local"]`) like a local session would, but they never see the job
token, so they can't fetch credentials themselves; only the job's own git commands can.

### Branch worktrees

Ralph jobs work in long-lived **branch worktrees** at
`<workspaceRoot>/.branches/<provider>/<repo path>/<branch with / replaced by __>`. A worktree is
created from the remote branch if it exists (otherwise from `origin/<base>`), runs the setup
command once, is reused by every job of the run and is locked while a job uses it. Uncommitted
leftovers of a failed attempt are stashed (labelled `omniralph ralph <run> <story> …`) and offered
to the next attempt.

Branch worktrees aren't removed automatically (cleanup after merge comes later). Delete
`<workspaceRoot>/.branches/<provider>/<repo path>/<branch>` once a run's PR/MR is merged, while the
agent isn't running a job for it, then `git -C <workspaceRoot>/<provider>/<repo path> worktree prune`.

## `workspaceRoot` and disk usage

- Repositories are cached as **blobless bare clones** in `<workspaceRoot>/<provider>/<repo path>`
  (default `~/.omniralph/repos`), cloned on the first job and fetched afterwards. Blobless clones
  hold all commits and trees but only the blobs that were checked out, so they grow with use.
- Each job checks out a **git worktree** in `<repo>/.worktrees/<jobId>`, removed when the job ends
  and pruned on startup after a crash. Peak usage is roughly the cached clones plus one full
  checkout per concurrently running job.
- Ralph runs also keep one **branch worktree** per run under `<workspaceRoot>/.branches/`,
  including whatever the setup command installs (e.g. `node_modules`). They're never pruned
  automatically; see [Branch worktrees](#branch-worktrees).
- Clone, fetch and worktree bookkeeping are serialized per repository with a lock file
  (`.locks/`), so two agent processes may share a workspace root, but don't point a manual checkout
  or cyralph at it.
- There's no automatic eviction yet. To reclaim space, stop the agent and delete a repository's
  directory (it's re-cloned on the next job), or the whole workspace root.
- Rough sizing: the sum of your repositories' blobless clone sizes, plus `max concurrency` × your
  largest checkout, plus headroom. Watch it with `du -sh ~omniralph/.omniralph/repos/*`.

## Coexisting with cyralph and manual dev work

- **Separate workspace root.** The agent's cache lives in the agent user's `~/.omniralph/repos`,
  separate from your manual checkouts and from cyralph's worktrees. Never point `--workspace-root`
  at a directory you or cyralph work in: worktrees there get pruned and repos fetched under you.
- **Separate credentials.** Job git commands reset `credential.helper` and use
  `omniralph-agent git-credential` (brokered, one repository, short-lived; read-only except for
  running `ralph` jobs), never your `gh`/`glab` logins or SSH keys. The dedicated user makes this
  structural: the agent can't read `/home/coder`.
- **Don't route the same issues to both.** cyralph and Omniralph's ralph capability are separate
  Linear apps with separate routing configuration, and neither knows about the other. If the same
  Linear team, project or label is routed in both, an issue that ends up delegated to both apps
  (or re-delegated from one to the other mid-run) gets two runs that push to the same branch and
  fight over the sub-issues' states and the PR. Give each app disjoint teams, projects and labels (or tag issues with
  `[repo=…]` for Omniralph), and move a team over by removing it from cyralph's config before adding
  it to a repository's **Linear team keys**. Don't delegate one issue to both apps.
- **Separate worktrees.** cyralph's worktrees and Omniralph's branch worktrees are separate
  checkouts. Don't work on a branch Omniralph is building from a cyralph or manual checkout: the
  next story's push would be rejected as diverged.
- **Shared Claude rate limits.** If the agent's user is logged in to the same Claude subscription as
  you or cyralph, all of them share its rate limits. The agent backs off and retries on rate limits
  instead of failing, but busy reviews still slow your sessions down. Lower the agent's max
  concurrency, or give it its own API key or subscription. See [claude-auth.md](claude-auth.md).
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
- **Revoked**: an admin revoked the agent on the **Agents** page.

What to do:

1. Stop the agent (`sudo systemctl stop omniralph-agent`, or `pm2 stop omniralph-agent`) so it
   stops being restarted.
2. For `refresh_reuse`, find out why before re-enrolling: check the agent's audit log (the IP the
   reused token came from), whether another host or process uses a copy of `agent.json`, and
   delete any copies. If you can't explain it, treat the host as compromised: rotate the Claude
   credentials on it and check the agent user's files.
3. Enroll again with a new enrollment token from **Agents › Enroll agent**, as the agent's user. This
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
