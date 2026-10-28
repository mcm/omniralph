# Installables and host tools

Some tasks need software on the agent's host: a code graph that gives reviews context, or
Semgrep/opengrep for a SAST check. Omniralph has two ways to get it there without an agent
release:

- An **installable** is a versioned npm package with an `omniralph` field in its `package.json`
  declaring the commands, MCP servers and skills it provides. An admin installs it on an agent
  from the control panel; the agent runs `npm install` into a directory it manages.
- A **host tool** is software the agent owner installs by hand (with the system package manager,
  a release binary…). The organization keeps a catalog of host tools by name, and each agent
  agrees with the control panel on the absolute path it runs each one from.

A task can require either, and only agents that have them claim its runs. This page is for
installable authors, admins and agent owners. The design is
[ADR 0008](adr/0008-agents-tasks-and-the-harness.md#installables-and-host-tools); task
requirements are in [definitions.md](definitions.md#derived-requirements); the agent's local
config is in [deploy-agent.md](deploy-agent.md#4-enroll).

## Writing an installable

An installable is an ordinary npm package, published to a registry the agent can reach. What
makes it an installable is an `omniralph` field in its `package.json`:

```json
{
  "name": "@omniralph/code-graph",
  "version": "1.2.0",
  "omniralph": {
    "commands": [{ "name": "code-graph", "bin": "bin/code-graph.js" }],
    "mcpServers": [{ "name": "graph", "command": "bin/graph-server.js", "args": ["--stdio"] }],
    "skills": ["skills/code-graph"]
  },
  "bin": { "code-graph": "bin/code-graph.js", "code-graph-mcp": "bin/graph-server.js" }
}
```

| Field | Meaning |
| -- | -- |
| `commands` | Executables setup and teardown commands can run by `name`. `bin` is the file to run. |
| `mcpServers` | stdio MCP servers agents can use. `command` is the server's executable, started with `args` (default none). |
| `skills` | Claude Code skills: directories with a `SKILL.md`, or single Markdown files. Loaded into the sessions of runs that require the installable (see below). |

Every field is optional (an empty list by default), so `"omniralph": {}` is a valid, if useless,
manifest. The rules:

- The package needs a valid npm `name` and a semver `version`, and the name can't start with `-`.
- Command and MCP server names are up to 64 lowercase letters, digits, `.`, `_` and `-`, starting
  with a letter or digit, and unique within their list.
- Every path is relative to the package directory and must stay inside it: no absolute paths, no
  backslashes, no `..` that leaves the package, not the package directory itself. Paths are
  normalized (`./bin//x.js` is `bin/x.js`).
- A `bin` or MCP server `command` must be executable as installed: a native binary, or a script
  with a shebang (`#!/usr/bin/env node`). Also list scripts in the package's npm `bin` field, which
  makes npm mark them executable on install whatever the tarball's file modes. The agent runs
  the file by its absolute path, never through `node` or a `bin` link on `PATH`.

Installables run as the agent's user, with no network or filesystem sandbox beyond the run's.
Keep their dependencies small: `npm install` also installs them, and runs their install scripts.

### Running inside a run

The agent runs an installable's commands and MCP servers by absolute path inside the installed
package, so an executable of the same name that the checkout puts on the run's `PATH` is never
picked instead:

- A setup or teardown command whose first word is the name of a command of an installable the
  task requires runs that command's `bin`. `code-graph index --base main` runs
  `<dataDir>/installables/node_modules/@omniralph/code-graph/bin/code-graph.js index --base main`.
  The first word ends at whitespace or one of `;&|<>()`; only the first word is replaced, so
  `make && code-graph index` runs `make` as written and `code-graph` from `PATH`. A host tool the
  task requires keeps its name over an installable command of the same name; two required
  installables providing the same command name fail the run.
- An agent lists an installable's MCP server in **Tools › MCP servers** as `<package>:<server>`
  (`@omniralph/code-graph:graph`). The server is attached to the agent's sessions and its tools
  are allowed. They are named `mcp__<package>_<server>__<tool>`, every character other than
  letters, digits, `_` and `-` replaced by `_` and leading `_` dropped:
  `mcp__omniralph_code-graph_graph__<tool>`. Review tasks attach it only to sessions that may
  explore the repository. Two listed servers that end up with the same session name fail the run.
- The skills of every installable a run requires (the task's **Requirements** installables, and the
  installables whose MCP servers the agent lists) are loaded into the run's sessions; an
  installable the run doesn't require never adds skills, even when it's installed. See
  [Skills](#skills).

### Skills

A `skills` entry is either a directory with a `SKILL.md` (Claude Code's skill format; the skill is
named after the directory and every file in it comes along, e.g. scripts the skill mentions) or a
single Markdown file (named after the file without `.md`, or after its directory for a
`SKILL.md`). Names are letters, digits, `.`, `_` and `-`, unique within the installable; keep a
`name` in the skill's front matter, if any, equal to it.

Claude Code only loads skills from settings or plugins, and most sessions load no settings at all,
so the agent wraps each required installable's skills in a plugin of its own: it copies them
into `<dataDir>/skill-plugins/<plugin>-<hash>/skills/<skill>/` next to a generated
`.claude-plugin/plugin.json`, and passes that directory to the session as a local plugin. Nothing
else from the package comes in (no hooks, agents, commands or MCP config), and no user, project or
local settings are loaded that the session wouldn't load anyway. The plugin is named after the
package (lowercase, every run of characters other than letters and digits replaced by `-`), so
`@omniralph/code-graph`'s skill `code-graph` is `omniralph-code-graph:code-graph`. Sessions that
load no settings enable exactly these skills and get the `Skill` tool; a session without tools
(e.g. a review's repair turn) gets none. The directory is keyed by a hash of the skills' contents,
so it's written once per version of them; old ones aren't pruned.

A required installable whose skill path is missing or isn't a skill, or with two skills of one
name, fails the run, as do two required installables whose plugin names collide.

### Caches

Indexing a repository from scratch on every run is slow, so each installable gets cache
directories on the agent, passed to its commands (as setup or teardown commands) and MCP servers
as environment variables:

| Variable | Directory | Set |
| -- | -- | -- |
| `OMNIRALPH_CACHE_DIR` | `<dataDir>/cache/<package>/<repository id>/` | On every run with a repository |
| `OMNIRALPH_PR_CACHE_DIR` | `<dataDir>/pr-cache/<package>/<repository id>/<number>/` | On a run for a PR/MR (triggers `pr.updated`, `pr.mention`, `review.rerun`, `finding.mention`, `pr.review-findings`, `pr.ci-failed`, `pr.fix-command`) |

The agent creates them (mode 0700) before the run. The installable owns what goes inside and how
it's keyed, e.g. an index per base commit in the repository cache and the PR's own changes on top
in the PR cache.

**Keep data derived from a PR out of the repository cache.** A PR's code is untrusted: whatever a
run of one PR writes to `OMNIRALPH_CACHE_DIR`, the runs of every other PR of that repository read.
Write only what you derive from the repository's trusted branches there (e.g. an index of the
default branch's commit); put everything that depends on the PR's changes in
`OMNIRALPH_PR_CACHE_DIR`, which only that PR's runs see. The PR caches are a separate tree, never
inside a repository cache.

Caches are best effort. Nothing is stored in the control panel, a run on another agent starts
cold, and a run without a repository gets neither variable. The agent doesn't prune them: the
installable (or the agent owner) does.

### Testing an installable locally

`npm pack` builds the tarball npm would publish. Install it into a scratch prefix the way the
agent does, and run the commands from there:

```sh
npm pack --pack-destination /tmp
npm install --prefix /tmp/omniralph-prefix --no-audit --no-fund -- /tmp/omniralph-code-graph-1.2.0.tgz
/tmp/omniralph-prefix/node_modules/@omniralph/code-graph/bin/code-graph.js --help
```

The `install` RPC only installs from the registry (`<name>@<version>`, never a path, tarball, URL
or `npm:` alias), so publish the package to try it on an agent.

## Installing an installable

Admins install or update an installable on one agent at a time: **Fleet › _agent_ › ⋯ › Install
package…**, enter the package name and a version (an exact version such as `1.2.0` or a
dist-tag; default `latest`) and **Install**. This queues an `install` system RPC targeted at that
agent; a revoked agent has no **Install package…**. Installing the same name and version again
while the first one is queued or running doesn't queue a second job.

On the agent, the RPC:

1. refuses the package unless the agent's local `installables.allow` matches its name (below);
2. runs `npm install --prefix <dataDir>/installables --save-exact -- <name>@<version>`, one install
   at a time, with the agent's own environment and npm config (`~/.npmrc` of the agent's user),
   never a job's credentials;
3. checks the installed `package.json`: a package without a valid `omniralph` field is removed
   again, or the version installed before is put back, and the job fails with the manifest's
   problems.

The agent's **Packages** section on Fleet lists the installables it reported in its last
heartbeat (`name@version`) and its installs in progress or failed, with the error. A
new installable shows up with the next heartbeat after the install, and the agent can claim
runs that require it from then on.

On the machine, the agent's own page ([Packages](deploy-agent.md#the-agent-page)) installs,
updates and removes installables through the same queue and checks, edits the allow-list, and
shows every install's npm output, Fleet's included.

Installables live in `<dataDir>/installables` (`~/.omniralph/installables` by default), an npm
prefix of their own, never `npm -g`: they can't collide with the agent package or depend on
whatever is installed globally. There's no uninstall RPC: remove one with **Remove…** on the
agent's page, which runs `npm uninstall` in that prefix.

## Host tools

A host tool is software the agent's owner installs by hand (e.g. `opengrep` or `gh`). There is no
organization catalog: each agent says where its tools are, and playbooks require them by name (the
executable's name: up to 64 lowercase letters, digits, `.`, `_` and `-`, starting with a letter or
digit).

### Paths on the agent

An agent's host tool paths are in its [`settings.json`](deploy-agent.md#machine-settings-settingsjson)
(`hostTools`, e.g. `{ "gh": "/opt/gh/bin/gh" }`), set on the agent's page
([Host tools](deploy-agent.md#the-agent-page): **Set path…**, **Use PATH**, **Add host tool…**) or
by hand. The agent
checks every name in its `hostTools` and every name in the control panel's `requiredHostTools`
(below):

1. A **configured** path is used when it's an executable file outside `blockedExecPaths`.
2. With no path configured, the agent uses the first executable of that name it **discovers** on
   its own `PATH` (the agent process's `PATH`, never a run's; relative entries and blocked paths are
   skipped).
3. A configured path that is **missing**, **not executable** or **blocked** makes the tool
   unavailable, rather than falling back to whatever is on `PATH`.

A change to `settings.json` is checked at once and reported with an immediate heartbeat, so the
control panel knows within seconds. After a restart the agent checks its configured tools before
its first heartbeat and the required ones right after it.

### What the control panel knows

Every heartbeat response carries `requiredHostTools`: the sorted names the organization's playbooks
require (built-in playbooks require none). Saving or deleting a playbook updates it on every
agent's next heartbeat. The agent answers with one entry per tool it configured or was asked
about: its name, the `path` it runs it from (none when unavailable), where that path came from
(`configured` or `discovered`) and, for an unusable configured path, the `problem` (`missing`,
`not_executable` or `blocked`). The control panel stores the report read-only; **Fleet** shows it
on the agent's detail, with the required tools the agent has no path for. The playbook editor
suggests the names the organization's agents report with a path and the names playbooks already
require, and accepts any other valid name.

A host tool always runs from its absolute path. A setup or teardown command whose first word is one
of the task's host tools (`opengrep scan --json .`) runs that path, even when the checkout puts an
executable of the same name earlier on the run's `PATH`. Only the tools the task requires are
resolved this way.

## Requiring them in a task

A task's **Requirements** list installables (npm package names) and host tools (executable names);
an agent listing `<package>:<server>` MCP servers adds those installables too. Only an agent whose
last heartbeat reports every required installable and every required host tool with a path claims
the task's runs; others leave them queued. See
[definitions.md](definitions.md#derived-requirements).

When no online agent of the organization reports a required host tool with a path (for a run
targeted at one agent, when that agent doesn't), the run says so instead of waiting silently: its
item under the Inbox's **Running** tab and its run detail read "Waiting for an agent with gh
installed" ("gh and opengrep", "a, b and c" for several), followed by an **Open Fleet** link. The
reason is refreshed when the run's attempt is queued, when an agent reports different host tools or
comes online, and every minute for agents that went offline or were revoked; it goes away as soon as
an agent with every required tool is online (or claims the run).

If an installable or host tool goes away between the claim and the run (or its new configured path
isn't checked yet), the run is retried after a minute, before anything is checked out. An MCP server
the agent lists but the installed version doesn't provide fails the run.

## Locking an agent down

The agent enforces these settings itself, whatever the control panel asks. `installables.allow`
and `acceptedTaskTypes` are in its `settings.json` (`~/.omniralph/settings.json`; see
[deploy-agent.md](deploy-agent.md#machine-settings-settingsjson)), `blockedExecPaths` and `dataDir`
in its `agent.json` (`~/.config/omniralph/agent.json`; see
[deploy-agent.md](deploy-agent.md#4-enroll)).

- **`installables.allow`** (default `["@omniralph/*"]`, edited on the agent's page under
  **Packages › Allow-list** or by hand): the package names the `install` RPC and the agent's page
  may install. Installing is remote code execution on the host by any admin of the organization, so
  only allow scopes you trust. A pattern is an exact name or contains `*`, which matches anything
  but `/`: `@omniralph/*` matches `@omniralph/code-graph`, not `@omniralph-evil/x`. `[]` refuses
  every install. A refused install fails its job with "_name_ isn't allowed on this agent".
  The allowlist only gates new installs: an installable installed before you narrowed it stays
  installed and usable until you remove it.
- **`blockedExecPaths`** (default `[]`): absolute path prefixes the agent never runs a host tool,
  installable command or installable MCP server from, whether a host tool's path was configured
  or the agent discovered it on `PATH`. Prefixes match
  whole path segments (`/opt/x` covers `/opt/x/bin/tool`, not `/opt/xy`), after resolving
  symlinks on both sides, so a link into a blocked directory is blocked too. A blocked configured
  path is reported **Missing** (and logged once as a warning), which makes the tool unavailable; a
  blocked discovered candidate is skipped and the search goes on along `PATH`. Every run checks
  its host tools, installable commands and MCP servers again before it starts and fails, naming the
  path, if one is blocked (e.g. a symlink changed since the last heartbeat, or `dataDir` is under a
  blocked prefix).
- **`dataDir`** (default `~/.omniralph`): where installables and their caches live. It holds code
  the agent runs, so keep it writable only by the agent's user.
- **`acceptedTaskTypes`** (default all of `query`, `review` and `coding`): the task types the
  agent runs. It reports them in every heartbeat and claim and is only handed jobs of those types,
  so a host you don't trust to push code can leave out `coding`. Housekeeping jobs (`repo.sync`,
  installs) always run.

Changes to `installables.allow` and `acceptedTaskTypes` apply at once: the next install and the
next claim use them. Changes to `agent.json` apply when the agent restarts.

## Troubleshooting

| Symptom | Cause |
| -- | -- |
| Install job fails with "isn't allowed on this agent" | The `installables.allow` of the agent's `settings.json` doesn't match the package name. |
| Install job fails with "isn't a valid installable" | The package has no `omniralph` field or it's invalid; the error lists each problem by field (`omniralph.commands.0.bin: …`). |
| Install job fails with "npm install … failed" | npm's error follows: usually the registry can't be reached or needs auth in the agent user's `~/.npmrc`. |
| A task's runs stay queued | A run that says "Waiting for an agent with … installed" needs a host tool no online agent has: open **Fleet** and set the tool's path on an agent's page (**Host tools**), or bring that agent online. Otherwise no agent has every requirement: check the task's **Requirements** against each agent's **Packages** on **Fleet**, and that the agent finds each host tool. |
| A host tool is unavailable on an agent | Its configured path doesn't exist, isn't an executable file, or is covered by `blockedExecPaths` (the agent logs a warning for a blocked one); or, with no path configured, nothing executable of that name is on the agent process's `PATH` outside `blockedExecPaths`: fix the `PATH` of the service that starts the agent (pm2, systemd). |
