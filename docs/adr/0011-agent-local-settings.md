# ADR 0011: Machine settings live on the agent, edited on its local page

- **Status:** Accepted (TOOL-741). Supersedes the central agent settings, host tool catalog and
  "Update now" of ADRs 0003, 0006, 0008 and 0010; their text stays as written.
- **Date:** 2026-10-28

## Context

Some settings belong to one machine: how many attempts it runs at once (slots and the per-pool
limits), which kinds of work it accepts, where its hand-installed host tools are, which npm
packages it may install, and which version it runs. Until 2.0 an admin set the slots, pool limits,
host tool paths and a per-agent desired version centrally (the agent settings, Host tools and
"Update now" routes, the `agents` columns behind them and the `host_tools` / `agent_host_tools`
tables), while the accepted kinds and the installables allow-list were keys in `agent.json` that no
page showed. Two sources for one machine's behavior meant an operator couldn't tell from either
place what the agent would actually do.

None of the central values was set in production: every agent's concurrency, pool limits and desired
version were null or default, and the host tool catalog and paths were empty.

## Decision

**The agent is the only source of its machine settings. It keeps them in a local `settings.json`,
edits them on a page it serves on 127.0.0.1, and reports them in its heartbeat. The control panel
stores what it is told, read-only, and claims and shows by it.**

### `settings.json`

- `<dataDir>/settings.json` (`~/.omniralph/settings.json` by default), mode 0600, written
  atomically. Its schema is `AgentLocalSettings` (`packages/shared/src/agent-settings.ts`, strict,
  `v: 1`): `maxConcurrency` (1–32, default 5), `poolLimits { long?, short? }` (1–`maxConcurrency`),
  `acceptedTaskTypes` (a non-empty subset of `query`, `review`, `coding`; absent means all),
  `hostTools` (name → absolute path), `installables.allow` (package patterns, default
  `["@omniralph/*"]`) and `update.pin` (at least `AGENT_MIN_VERSION`). The same schema validates the
  file, the page's request bodies and the heartbeat report. A missing file means every default.
- `agent.json` keeps identity and bootstrap only: `server`, `agentId`, `refreshToken`,
  `workspaceRoot`, `dataDir`, `blockedExecPaths` and `ui { enabled, port, allowedHosts }`. It
  refuses a file that still has `acceptedTaskTypes` or `installables`, naming `settings.json`, and
  `omniralph-agent import` writes those keys into `settings.json`. Keeping two files stops page edits
  and token rotation (which rewrites `agent.json`) from racing, and keeps the refresh token out of
  the page's reach. The paths and `blockedExecPaths` aren't editable from the page: moving a path
  moves gigabytes, and the page must not be able to loosen its own guard.
- Every read carries a revision (the SHA-256 of the file's bytes, or `"none"`); a save based on an
  older revision answers 409 with the current settings. The daemon watches the file (debounced
  250 ms): a valid hand edit applies like a page save, an invalid one is ignored and shown on the
  page, and the last good settings stay in force.
- A change applies at once, without a restart: the daemon re-evaluates which pools it claims from
  and how many slots are free (lowering a limit cancels nothing), re-checks host tools, uses the new
  allow-list for the next install, re-evaluates the update target, and heartbeats immediately.

### Version precedence

Highest first: a local "Update now" (the page or `omniralph-agent update`), the local pin, the
organization's policy (`desiredVersion` in the heartbeat response, from the `agent.desiredVersion`
app setting edited on Fleet), not managed. Failed versions are skipped, except by "Update now". A
failed pin doesn't fall back to the policy.

### What the control panel keeps

- The heartbeat request carries `local { maxConcurrency, poolLimits, versionPin, installablesAllow }`,
  `hostTools` (name, path, source, problem) and `claude { status, source, checkedAt }` (the account
  email never leaves the machine). The heartbeat handler stores them in `agents.reported_*` columns,
  publishes the `agent` live event when one changes, and claims jobs by them: an agent's usable host
  tools are its reported entries with a path.
- The heartbeat response carries `desiredVersion` (the org policy), `requiredHostTools` (the union of
  the organization's playbooks' requirements) and `pinnedRepositories`. It no longer carries slots,
  pool limits, host tool paths or an update request.
- Fleet shows the reported values read-only. Its "Install package…" still sends the install, and the
  agent's local allow-list still vetoes it. The org version policy, the audit log and Revoke stay
  central: revoking a stolen token has to work when the machine itself is compromised.
- A queued job that needs host tools no online agent of its organization reports gets a
  `jobs.waiting_reason`, and its run says "Waiting for an agent with <names> installed" with a link
  to Fleet.

### Dropped

`/api/ui/agents/[id]/settings`, `/api/ui/agents/[id]/host-tools`, `/api/ui/agents/[id]/update`,
`/api/ui/host-tools` and `/api/ui/host-tools/[id]`; the `maxConcurrency` field of
`/api/ui/agent-defaults` (a `PUT` containing it answers 400); the `host_tools` and
`agent_host_tools` tables; the `agents` columns `max_concurrency`, `pool_limits`, `desired_version`,
`update_request_id`, `update_request_version` and `update_requested_at`; and the
`agent.maxConcurrency` app setting. None is kept as a report path, because the heartbeat is the
report path.

Migration `0114_drop_agent_machine_settings.sql` first runs a guard that raises "Set these on the
agent's page first: <list>" when a non-deleted agent has one of those values set, either table has a
row, or an `agent.maxConcurrency` setting exists. No database value can reach a machine's
`settings.json`, so dropping one silently would change that machine's behavior. Soft-deleted agents'
values are dropped without a check.

### The local page and its auth model

- The daemon serves a static Vite + React bundle (`apps/agent/ui`, built into `dist/ui` and shipped
  in the package) and a JSON API with a server-sent event stream, with Node's `http` and no new
  runtime dependency. It binds 127.0.0.1 only, on `ui.port` (default 7410, falling back to an
  ephemeral port when taken). Remote users forward the port (`coder port-forward`, `ssh -L`).
- Each start makes a 32-byte random token and writes it with the URL to `ui.json` (mode 0600, next
  to `agent.json`, deleted on shutdown). `omniralph-agent ui` checks the daemon is alive and prints
  `<url>/?token=<token>`. Opening that URL sets an `HttpOnly`, `SameSite=Strict` cookie named after
  the port and redirects without the token; every other request needs the cookie. Anyone who can
  read `ui.json` can already read `settings.json`, so the token adds no new trust boundary on the
  machine; it keeps other local users' browsers and other websites out.
- Every request is checked for a `Host` of `127.0.0.1:<port>`, `localhost:<port>` or an exact name
  in `ui.allowedHosts` before auth or routing (DNS rebinding answers 403). Mutations need an
  `Origin` equal to `http://<Host>` and a JSON body (CSRF). The page sends a strict CSP,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (the first URL carries the token) and
  `no-store` on HTML and API responses.
- A restart changes the token, so the page answers 401 and asks to run `omniralph-agent ui` again.

## Alternatives considered

- **Keep the settings central, with the agent reporting what it applied.** Two writers for one value
  needs precedence rules per field and conflict copy on both sides, and machines a team member
  administers by hand would still be edited from a page they don't see.
- **Keep the central routes as report paths.** The heartbeat already carries every value; a second
  path would only add a write route to protect.
- **Edit the settings in `agent.json`.** Token rotation rewrites it, so a page save and a rotation
  could lose each other's write, and the page would have the refresh token in reach.
- **Bind another address for remote access.** Port forwarding already gives Coder and SSH users the
  page, without exposing a settings editor on the network.
- **Copy the control panel's components into the agent.** The bundle is built from `@omniralph/ui`
  instead, so a change there needs an `@omniralph/agent` changeset, as for the other bundled packages.

## Consequences

- An operator changes slots, kinds, host tool paths, the allow-list and the pin on each machine's
  page (or in its `settings.json`); Fleet shows them within a heartbeat.
- Signing in to Claude, starting and stopping runs, cleanup and repo sync stay out of the page: the
  page shows the Claude login state, links attempts to their runs and shows storage read-only.
- The control panel can no longer change a compromised machine's settings, only revoke it.
