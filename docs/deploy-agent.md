# Deploying an agent

`omniralph-agent` is a Node 22 daemon that claims jobs from the control panel and runs them with
the Claude Agent SDK. It only makes **outbound HTTPS** calls: to the control panel (its agent API),
to the code host (git clone/fetch with brokered, read-only tokens; `ralph.*` jobs also
push with brokered write tokens) and, when the control panel has `ABLY_API_KEY` set, to Ably's
realtime endpoint (a WebSocket to `main.realtime.ably.net:443`, falling back to
`main.[a-e].fallback.ably-realtime.com` and checking connectivity at `internet-up.ably-realtime.com`)
for its job wake signals ([ADR 0009](adr/0009-ably-wake-signals.md)). If Ably is unreachable the
agent still picks jobs up through its heartbeat, within 20s. It opens no port except an optional
`/healthz` on `127.0.0.1`.

This guide sets one up on a Coder workspace, running as the **workspace user** (`coder`): the
agent's config, repo cache and Claude login live in that user's home, which the workspace persists.
On a dedicated or shared server you may want a **dedicated Unix user** instead, to keep the
agent's refresh token and Claude login away from other sessions on the host (see
[Optional: a dedicated user](#optional-a-dedicated-user)). The rest of this guide calls whichever
user runs the agent _the agent's user_.

## Prerequisites

- Node 22 (≥ 22.12) on the agent user's `PATH`. On Coder the workspace's Node (system-wide or
  nvm) is fine. For a dedicated user or a systemd unit, install it system-wide (e.g.
  `/usr/bin/node`): a Node installed with nvm under `/home/coder` isn't visible to other users.
- git ≥ 2.40 (2.44+ recommended: older versions lazily fetch commits while checking whether they're
  cached).
- `sudo` on the host only if you create a dedicated user or install a systemd unit.
- An admin account in the control panel organization the agent should serve.
- For coding work (`coding` tasks), also a git identity and the target repositories' toolchains: see
  [Coding work](#coding-work).

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
read-only, but coding sessions run commands with full permissions in their worktree (see
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
[Self-update](#self-update-pm2)). Releases are made with changesets and a "Version Packages" pull
request: see [apps/agent/README.md › Releasing](../apps/agent/README.md#releasing).

Machines that run the old `@omniralph/harness` package (0.13 and earlier) can't self-update to
`@omniralph/agent`: move them once as in [Moving from @omniralph/harness](#moving-from-omniralphharness).

### Moving from @omniralph/harness

Up to 0.13 the agent was published as `@omniralph/harness`, with the `omniralph-harness` binary, the
config file `~/.config/omniralph/harness.json` and the `OMNIRALPH_HARNESS_CONFIG` variable. From
2.0.0 it's `@omniralph/agent`, `omniralph-agent`, `~/.config/omniralph/agent.json` and
`OMNIRALPH_AGENT_CONFIG`. The control panel speaks only to `@omniralph/agent`, so an old daemon stops
working at the cutover. Self-update can't cross a package name, so move each machine by hand once, as
the agent's user. `omniralph-agent import` brings it back as the same agent: same ID, central config,
pins and audit log, with no new enrollment.

1. **Stop the old daemon**, so it can't rotate the refresh token the import copies:
   `pm2 stop omniralph-harness` (`pm2 ls` shows its name), `sudo systemctl stop omniralph-harness`,
   or `Ctrl-c` in its tmux session. Under pm2, stop it rather than deleting it: `import` then prints
   the commands that replace it.
2. **Install the agent**: `npm install -g @omniralph/agent`, then `omniralph-agent --version`
   (2.0.0 or later).
3. **Run `omniralph-agent import`.** It reads the old config from `--from <file>`, else
   `OMNIRALPH_HARNESS_CONFIG`, else `~/.config/omniralph/harness.json`, and writes
   `~/.config/omniralph/agent.json` (or `--config <file>`/`OMNIRALPH_AGENT_CONFIG`; mode 0600). It
   makes no network call and leaves the old install untouched. Run it with
   `--dry-run` first to see the summary without writing anything. The summary has one line per
   setting:
   - **imported**: copied as it was. The refresh token shows as `imported (hidden)` and is never
     printed.
   - **default**: the old config didn't set it, so the agent uses its default (see [Enroll](#4-enroll)).
   - **not imported: unknown key**: a key the agent doesn't know. It's dropped.
   - **not imported: versions of @omniralph/harness**: `update-state.json` and `update-request.json`
     name old package versions, so they stay behind. Self-update starts afresh.
   - **imported into settings.json**: `acceptedTaskTypes` and `installables.allow` go to
     [`settings.json`](#machine-settings-settingsjson) in the data directory (mode 0600, merged into
     one already there), not `agent.json`. The file is only written when the old config set one of
     them.
   - **default (set them on the agent's page)**: slots, pool limits, host tool paths and the version
     pin were never in the old file and start at their defaults.
   - **kept by the control panel**: pins and the desired version carry over in the control panel
     (see [Central config](#central-config)).

   Warnings follow when the `workspaceRoot` or data directory is missing: the agent then clones
   repositories and reinstalls installables again, which is slow but harmless. The import refuses,
   writing nothing, when:
   - no old config exists: there's nothing to import, so [enroll](#4-enroll) the machine instead;
   - the old config can't be used (readable by group or others, not JSON, a key missing or
     invalid): it names each problem. Fix them and run it again;
   - the old daemon is still running: stop it (step 1). `--force` imports anyway, but two processes
     sharing one refresh token revoke the agent;
   - `settings.json` exists in the data directory but isn't valid: fix or remove it;
   - `agent.json` already exists (for example from an install up to 0.8.0, when the package was
     called `@omniralph/agent` the first time): `--force` backs it up to
     `agent.json.bak-<timestamp>` and replaces it.
4. **Start the agent under pm2 with the printed commands.** When pm2 ran the old daemon, `import`
   prints `pm2 delete omniralph-harness`, a `pm2 start … --name omniralph-agent … -- start …`
   that keeps the old process's arguments, and `pm2 save`. Run them in that order. pm2 starts the
   new process with your current shell's environment, so set `ANTHROPIC_API_KEY`,
   `CLAUDE_CODE_OAUTH_TOKEN` and `OMNIRALPH_LOG_LEVEL` again first if the old process had them. For
   systemd, rename the unit to `omniralph-agent.service` and point `ExecStart=` at
   `…/node_modules/@omniralph/agent/dist/cli.js` ([systemd](#systemd)); for tmux, use the
   [tmux commands](#tmux). Update the Coder template's startup script to match. Then check that
   `curl -s http://127.0.0.1:9310/healthz` says `"connected": true` and that **Fleet** shows
   the new version after the next heartbeat.
5. **Uninstall the old package** once the agent is back: `npm uninstall -g @omniralph/harness`.
6. **Never start the old daemon again** once the agent has run: the agent rotates the refresh token
   on its first exchange, so the old daemon would present a used token and the control panel would
   revoke the agent (see [Re-enrollment](#re-enrollment-refresh_reuse-re-enrollment-required)).

Self-update works again from then on.

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

As an admin of that organization, open **Fleet › Enroll** in the control panel. It shows a one-time command with
an enrollment token (single use, valid for 1 hour). Run it as the agent's user:

```sh
omniralph-agent enroll --server https://omniralph.example.com --token <enrollment-token> \
  --name coder-dev-1 --workspace-root ~/.omniralph/repos
```

`--name` defaults to the hostname and `--workspace-root` to `~/.omniralph/repos`.

This writes `~/.config/omniralph/agent.json` (mode 0600, directory 0700) with the server URL, agent
ID, refresh token and `workspaceRoot`. `--config <file>` or `OMNIRALPH_AGENT_CONFIG` choose
another path, for `enroll` and `start` alike.

`agent.json` holds the agent's identity and bootstrap only. You can add these optional keys by
hand. Token rotation keeps them, and they stay out of the file when unset:

| Key                | Default        | Meaning                                                                                                                                                                                                                                                                                                       |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blockedExecPaths` | `[]`           | Absolute path prefixes the agent never executes: host tools (configured or discovered on `PATH`), installable commands and installable MCP servers. Matches whole path segments (`/opt/x` covers `/opt/x/bin/tool`, not `/opt/xy`) after resolving symlinks on both sides.                                   |
| `dataDir`          | `~/.omniralph` | Absolute directory for the agent's installables, their caches and `settings.json`.                                                                                                                                                                                                                            |
| `ui.enabled`       | `true`         | Whether the agent serves its page.                                                                                                                                                                                                                                                                            |
| `ui.port`          | `7410`         | The agent page's port (1–65535). The page is served on 127.0.0.1 only.                                                                                                                                                                                                                                       |
| `ui.allowedHosts`  | `[]`           | Extra host names (no scheme or port) the page answers to, for a port-forwarding proxy such as Coder's dashboard.                                                                                                                                                                                             |

```json
{
  "server": "https://omniralph.example.com",
  "agentId": "…",
  "refreshToken": "…",
  "workspaceRoot": "/home/coder/.omniralph/repos",
  "blockedExecPaths": ["/opt/untrusted"],
  "ui": { "port": 7410 }
}
```

An invalid value stops the agent at startup with an error naming the key. Edit the file while the
agent is stopped: it rewrites the file when it rotates its refresh token, and a re-enrollment
replaces it. `acceptedTaskTypes` and `installables` moved to `settings.json` (below): an
`agent.json` that still has them stops the agent with "`<key>` moved to settings.json". Move them
by hand (`omniralph-agent import` does it for an `@omniralph/harness` config).

### Machine settings (`settings.json`)

The agent's machine settings live in `settings.json` in its data directory
(`~/.omniralph/settings.json` by default), written with mode 0600. The agent is their only
source: no control panel page sets them. Without the file every setting has its default. Every
key but `v` is optional:

| Key                  | Default                                           | Meaning                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`                  | —                                                 | Always `1`.                                                                                                                                                                                                                                                                                                              |
| `maxConcurrency`     | `5`                                               | Slots: how many attempts the agent runs at once, 1–32.                                                                                                                                                                                                                                                                  |
| `poolLimits.long`    | slots − 1 (at least 1)                            | How many slots coding attempts may take, 1 to the slots. By default one slot stays free for reviews and asks.                                                                                                                                                                                                           |
| `poolLimits.short`   | the slots                                         | How many slots reviews, asks and triage may take, 1 to the slots.                                                                                                                                                                                                                                                       |
| `acceptedTaskTypes`  | all three                                         | The task types the agent runs: a non-empty list of `query`, `review` and `coding`, each once (see [Central config](#central-config)). `repo.sync` and other housekeeping jobs always run. The agent reports it in every heartbeat and claim and only gets jobs of these types; the control panel shows it read-only.     |
| `hostTools`          | `{}`                                              | Host tool paths by name (`{ "gh": "/usr/bin/gh" }`), each absolute. A tool without one is looked up on `PATH`.                                                                                                                                                                                                         |
| `installables.allow` | `["@omniralph/*"]`                                | npm package patterns the agent accepts installables from. A pattern is an exact package name or contains `*`, which matches any characters except `/`: `@omniralph/*` matches `@omniralph/codegraph` but not `@omniralph-evil/x`. `[]` allows none. The agent enforces this itself, whatever the control panel asks. |
| `update.pin`         | none                                              | An agent version (2.0.0 or later) that wins over the organization's version policy.                                                                                                                                                                                                                                     |

```json
{
  "v": 1,
  "maxConcurrency": 4,
  "poolLimits": { "long": 2 },
  "acceptedTaskTypes": ["query", "review"],
  "installables": { "allow": ["@omniralph/*", "@acme/*"] }
}
```

The file accepts no other key. The accepted task types and the allow-list apply without a restart:
the next claim and the next install use them. The agent doesn't apply slots, pool limits, host tool
paths and the pin from the file yet; until it does, they come from the control panel as described
in [Central config](#central-config).

Edit the settings on the agent's page, or by hand while the agent runs. The agent watches the file
and applies a valid edit about a quarter of a second after the last write. It ignores an invalid
edit: it keeps its last good settings, logs "settings.json isn't valid: …; the agent keeps its last
good settings" and shows the problem on its page until the file is valid again. A `settings.json`
that isn't valid when the agent starts stops it with an error naming the key.

[installables.md](installables.md) explains installables, host tools and how these keys lock a
host down.

The refresh token rotates every ~15 minutes and is rewritten atomically. **Never copy the file to
another host or restore an old backup of it**: presenting an old refresh token looks like token
theft and revokes the agent (see _Re-enrollment_). To run another agent, enroll it separately.

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
- To upgrade: choose a version with **Fleet › Version policy › Edit** and the agent updates itself (see below),
  or trigger an update with `omniralph-agent update` on the host ([Triggering an update](#triggering-an-update)). By hand: `npm install -g @omniralph/agent@latest && pm2 restart omniralph-agent`.
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
# SIGTERM: stop claiming, give running jobs up to 60s; unfinished jobs are redelivered.
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
   2 hours are aborted; their leases lapse, so they're redelivered.
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
Failed versions are reported in the heartbeat (the agent shows **Update failed** on Fleet) and never retried by that
agent on its own; to try one again after fixing the host, [trigger an update](#triggering-an-update). With `--max-restarts 5`, pm2 still allows the four starts a rollback
needs.

**Choosing the version.**

- **Fleet › Version policy** holds the organization's desired version (it applies to the
  organization's agents only); admins change it with **Edit**: **Pin a version**, e.g. `2.0.0`
  (semver; nothing below 2.0.0), or **Track latest**. Until one is chosen, versions aren't managed:
  agents keep whatever they run. Each change shows behind the cell's ⓘ.
- **Track latest** follows the package's `latest` dist-tag, so agents update with
  each release. The control panel reads it from the npm registry without a token (the package is
  public) and keeps it in the database, reading it again once it's 5 minutes old; every heartbeat
  then hands out that version. If the registry can't be read, agents get the last version read
  (none before the first read: they stay where they are) and agents stay behind it on Fleet.
- A version for one agent (e.g. to try a release on one host first, or to keep a host on an older
  version) belongs to the agent machine: it moves to the agent's local config, and the control
  panel has no page for it. Until then every agent follows the organization's version.
- To pin every agent, set the organization's version to an exact version instead of `latest`;
  agents never move on their own.

**Fleet** shows whether every online agent runs the desired version ("All agents on 2.0.3", "2
agents behind", "1 update failed"); each agent's row and detail show **Updating** or **Update
failed** while that applies, and its detail the version it reports.

Agents not run by pm2 (systemd, tmux) report `selfUpdate: "unsupported"`, never install anything
and stay behind on Fleet: upgrade them by hand as in [Install](#2-install).

#### Triggering an update

An update can also be started on demand, on the host:

- `omniralph-agent update` on the host (as the agent's user, with the same `--config` as `start`).
  It writes `update-request.json` next to `agent.json` (mode 0600); the running agent picks it up
  with its next heartbeat and removes it. If the agent isn't running, it acts on it once started.

Either way the agent updates (drain, install, restart, rollback as above) to the desired version,
or to the package's `latest` on npm when none is chosen or the organization tracks `latest`, and retries that version even if it's in
`failed` (it's taken off the list first). A request for the version already running does nothing.
Choosing a different version than the desired one isn't possible this way: the agent would
update back to the desired version straight away, so change the desired version instead. Agents
not under pm2 only log the request.

## Central config

Everything except the local files (`agent.json` and `settings.json`, see [Enroll](#4-enroll),
including the task types the agent runs) is configured centrally and delivered in every heartbeat response (every
20s), so changes need no restart:

| Setting                                                             | Where                                                                                      | Default                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Max concurrency (parallel jobs)                                     | the agent's `settings.json` (see below)                                                    | 1                                                                  |
| Concurrency per pool (1 to max concurrency)                         | the agent's `settings.json` (see below)                                                    | `long`: max concurrency − 1 (at least 1); `short`: max concurrency |
| Pinned repositories                                                 | **Repos › Agents** (**Fleet** lists them, read-only)                                       | none (every agent is eligible for every repo)                      |
| Desired agent version ([self-update](#self-update-pm2), pm2 only) | **Fleet › Version policy**                                                                 | none (not managed)                                                 |
| Job cancellations                                                   | **Jobs** (cancel)                                                                          | —                                                                  |

Max concurrency, pool limits and host tool paths belong to the agent machine, like its accepted
task types: they move to its [`settings.json`](#machine-settings-settingsjson), and the control
panel has no page for them. Until the agent applies them from there
the control panel still delivers them in the heartbeat, so every agent runs with the defaults
above.

Accepted task types decide what a host may run (trust), so the host itself decides them: the
`acceptedTaskTypes` key of its [`settings.json`](#machine-settings-settingsjson) (all three when
unset), applied as soon as it changes.
`query` covers replies, code questions, learned rules and triage, `review` PR/MR reviews and
`coding` the jobs of coding runs (`ralph.*`), which change code and push. `repo.sync` and other housekeeping jobs always run.
The agent sends its list in every heartbeat and claim, and only claims jobs of those types (and
only asks for the pools they run in); the control panel stores what it reports and shows it on
**Fleet**, read-only. Pool limits decide how many of an agent's
slots one pool's jobs may take (concurrency): `short` holds query and review jobs, `long` coding
jobs. The agent only claims a pool's jobs while that pool is under its limit, so with the default an
agent with two or more slots always keeps one free for reviews while hours-long stories run.
Lowering a limit cancels nothing: the agent just takes no new jobs of that pool until it is
under the new limit.

Accepted task types and pool limits replace the former capabilities (`review`, `ralph`, `triage`)
and their concurrency caps. A job can carry a minimum agent version (`jobs.min_agent_version`);
agents older than that leave it queued. Every `@omniralph/agent` release (2.0.0 or later) runs
every task type. The control panel sends each job's
prompt, tools and model with the job (its run spec), so changing a task needs no agent release.
A task's setup and teardown commands (e.g. Semgrep feeding a review) run on the host, in the job's
worktree, with whatever is on the agent's `PATH` and without the job tokens. See
[ADR 0008](adr/0008-agents-tasks-and-the-harness.md) for task types, pools, run specs and review
runs.

Pinning a repository to an agent routes its jobs to that agent only and makes the agent pre-clone it
(`repo.sync`). **Fleet** shows each agent's status (online, offline since its last heartbeat,
running), its running and recent work, its packages, its security line and, under **⋯ › Audit
log**, its audit log (enrollment, token refreshes, credential issuance, revocation).

## Coding work

Om builds delegated Linear issues story by story (see [linear.md](linear.md)
for the Linear side and [ADR 0003](adr/0003-ralph-orchestration.md) for the design). An agent
runs these jobs for a run: `ralph.story` (a Claude session, the quality gates, commit and push),
`ralph.request` (one Claude session for an @mention, a reply, review findings or a failed CI run,
on the run's branch), `ralph.describe-pr` (a read-only session writing the PR/MR description), and
the system RPCs `worktree.exec` (a manual story's approved preparation commands, no session) and
`worktree.cleanup` (removes a closed PR/MR's or stopped run's worktree, and after a merge the local
branch, no session). `ralph.prepare` and `ralph.cleanup` jobs queued before the upgrade still run.
Running `ralph.story` and `ralph.request` sessions also take Linear replies live: the heartbeat
response carries them (`jobMessages`) and the agent acknowledges them in its next heartbeat.
Jobs download the run's Linear attachments through the control panel and cache them in
`<workspaceRoot>/.attachments/`.

### Coding runs

A repository's runs work stories and requests as coding runs of its story and request tasks
(its `storyPlaybookId` and `requestPlaybookId`, saved with its review settings, by default the built-in
playbooks `builtin:implement-story` and `builtin:handle-request`, with the engineer persona), and write each
PR/MR description with a query run of `builtin:describe-pr` (see
[ADR 0008](adr/0008-agents-tasks-and-the-harness.md#coding-runs)). Only the agent's own git
commands can push: the session's git gets a read-only credential, and a request session publishes
its work by calling the `ship` tool, which makes the agent commit, push and return what happened.
A story task that pushes only at the end pushes story commits to a hidden ref and the branch once,
with a `ralph.push` job, before the PR/MR is described.

Each lane of a run sticks to the agent that ran its last job, so a run whose agent is offline
waits for it to come back (see [Enabling coding work](#enabling-coding-work)). The repository's coding **Model** isn't applied to the description run
yet (it uses `opus`).

### Enabling coding work

An agent runs every task type unless its `settings.json` lists `acceptedTaskTypes`. To let an agent
that lists them run coding work, add `coding` to the list (or remove the key); the agent applies
it at once. The agent then also claims its organization's `ralph.*` jobs (`coding` task type,
`long` pool; see
[ADR 0004](adr/0004-organizations.md#job-isolation)).

- Each lane of a run (one per repository its stories are in) sticks to the agent that started its
  jobs: the lane's later story, request, push and describe jobs are targeted at that agent, so keep
  `coding` accepted on it until its runs finish. If you untick `coding` on it or revoke it, the lane's
  next job goes to an agent its repository is pinned to, else to any agent that accepts `coding`,
  which recreates the branch worktree from the pushed branch.
- A repository pinned to agents (**Repos › Agents**) starts its runs on a pinned
  agent, so at least one of them needs to accept `coding`, or the run's jobs are never picked up.
- Coding sessions are long and write code: give the agents that run them their own host (or keep **Max
  concurrency** at 1) if you also develop on it.

### Host prerequisites

Unlike reviews, coding sessions run the repository's own tools, with full permissions
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
  a running coding run's lifecycle token, a legacy `ralph.*` job's token or a `worktree.cleanup`
  RPC), and the control panel opens and updates the PR/MR itself. Sessions can
  use any `gh`/`glab` login, SSH key or API token the agent's user has. Running as your workspace
  user, that includes yours: if coding sessions shouldn't be able to act as you on the code host,
  log out of them on that workspace or use a dedicated user.

Claude Code sessions in a coding job load the agent user's `~/.claude/` settings, skills and
`CLAUDE.md` plus the repository's `.claude/` settings and `CLAUDE.md`
(`settingSources: ["user", "project", "local"]`) like a local session would. Their git credential
helper uses the run's session token, which only ever gets a read credential, so only the agent's
own git commands (and `ship`) can push.

### Branch worktrees

Coding jobs work in long-lived **branch worktrees** at
`<workspaceRoot>/.branches/<provider>/<host>/<repo path>/<branch with / replaced by __>`. A worktree is
created from the remote branch if it exists (otherwise from `origin/<base>`), runs the setup
command once, is reused by every job of the run and is locked while a job uses it. Uncommitted
leftovers of a failed attempt are stashed (labelled `omniralph ralph <run> <story> …`) and offered
to the next attempt.

Every branch worktree gets a `pre-push` hook that rejects pushes to any branch but its own (a
guardrail against mistakes, not a security boundary).

After a lane's PR/MR merges, a `worktree.cleanup` system RPC on that lane's agent (the one that ran its jobs and holds its worktree) removes the branch worktree
and deletes the local branch (keeping a branch with unmerged commits until someone answers in
Linear); see [linear.md](linear.md#reviews-and-bot-requests-on-om-prsmrs). After a PR/MR closes
without merging, or the run is stopped, the same RPC stashes uncommitted work and removes the
worktree but keeps the local branch (a resumed run recreates the worktree from it; a local branch
ahead of `origin` is never reset). Nothing deletes a branch on `origin`. A run whose story task
pushes only at the end keeps its story commits on a hidden ref (`refs/omniralph/runs/<run>`); once
the run completes or fails, a `worktree.cleanup` RPC with only those refs (on any agent, no repository
clone needed) deletes them on `origin` with git. The daily `prune-hidden-refs` cron catches missed
ones and deletes refs older than 14 days whose run isn't running (a stopped run keeps its ref until then). Worktrees of repositories
with **Clean up after the merge** off, and of an agent that was revoked stay: delete `<workspaceRoot>/.branches/<provider>/<host>/<repo path>/<branch>` while
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
  again at its new path; delete the old directory once nothing needs it. A branch worktree that
  can't be moved stays at its old path, still linked to the moved repository.
- Each job checks out a **git worktree** in `<repo>/.worktrees/<jobId>`, removed when the job ends
  and pruned on startup after a crash. Peak usage is roughly the cached clones plus one full
  checkout per concurrently running job.
- Coding runs also keep one **branch worktree** per run under `<workspaceRoot>/.branches/`,
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
  running `ralph.*` jobs), never your `gh`/`glab` logins or SSH keys. Coding sessions run as the
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
  the whole token family **and the agent**, and the agent's **Security** line on Fleet shows
  "Token reuse detected". Causes: the config file was copied to another host or restored from a backup, two
  processes ran with the same config, or the agent crashed between receiving and saving a rotated
  token.
- **Revoked**: an admin of its organization revoked the agent (**Fleet › _agent_ › ⋯ › Revoke agent…**).

What to do:

1. Stop the agent (`sudo systemctl stop omniralph-agent`, or `pm2 stop omniralph-agent`) so it
   stops being restarted.
2. For `refresh_reuse`, find out why before re-enrolling: check the agent's audit log (the IP the
   reused token came from), whether another host or process uses a copy of `agent.json`, and
   delete any copies. If you can't explain it, treat the host as compromised: rotate the Claude
   credentials on it and check the agent user's files.
3. Enroll again with a new enrollment token from **Fleet › Enroll** (in the same
   organization), as the agent's user. This
   creates a **new agent** (new ID) and overwrites `agent.json`; the revoked agent stays in the list
   for its history.
4. Pin the old agent's repositories to the new one again from **Repos › Agents** (pins belong to
   the agent ID). Add back any optional keys of the old `agent.json` you used
   (`blockedExecPaths`, `dataDir`, `ui`). `settings.json` stays as it was.
5. Start the agent again.

When an admin revokes an agent, its running jobs are re-queued at once. After a `refresh_reuse`, the
agent's unfinished jobs are redelivered once their leases lapse (2 minutes without a heartbeat). Either way another agent (or
the newly enrolled one) picks them up.

## Troubleshooting

- **`agent.json is accessible by group or others`**: `chmod 600` it (and `chmod 700` its directory).
- **`agent.json not found`**: the agent runs as a different user or with a different `--config` /
  `OMNIRALPH_AGENT_CONFIG` than `enroll` used. On a machine that ran `@omniralph/harness`, run `omniralph-agent import`
  ([Moving from @omniralph/harness](#moving-from-omniralphharness)).
- **`/healthz` says `"connected": false`**: the control panel is unreachable or rejected the access
  token. Check the logs for the HTTP status.
- **Stories fail every attempt on a quality gate** with `command not found` or similar: the
  gate's toolchain isn't installed for the agent's user or isn't on the unit's `PATH`
  ([Host prerequisites](#host-prerequisites)).
- **Coding jobs stay queued**: no agent accepts the `coding` task type, the lane's sticky (or pinned) agent is
  offline, or it runs a version older than the job's minimum. Check **Jobs** for the job's status.
- **Reviews stay queued**: no online agent accepts the `review` task type (or, if the repository pins jobs to agents, none of the pinned ones). Update the agent
  ([self-update](#self-update-pm2) or `omniralph-agent update`).
- **Reviews fail with a Claude login message**: log in again as the agent's user
  ([claude-auth.md](claude-auth.md)).
