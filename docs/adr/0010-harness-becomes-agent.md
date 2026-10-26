# ADR 0010: The harness becomes the agent, and the AI is Om

- **Status:** Accepted (TOOL-570). Renames what ADRs 0001–0009 call the harness; their text stays as
  written.
- **Date:** 2026-10-26

## Context

Up to 0.8.0 the machine that runs jobs was the "agent" (`@omniralph/agent`). TOOL-314, TOOL-320 and
TOOL-324 renamed it to the "harness" (`@omniralph/harness`, `omniralph-harness`, the `harnesses`
tables, `/api/harness/*`, the Harnesses pages) because "agent" also meant the custom agent and task
definitions under `/api/ui/agents` and `/settings/agents`.

Omniralph 2.0 replaces those definitions with playbooks, which frees the word. It also settles the
terms the product uses, as Buildkite and Azure Pipelines do: the machine is an **agent**, the AI
that does the work is **Om**, and the product and its Linear agent stay **Omniralph**. "Harness"
meant nothing to new operators, and copy that called the AI "Ralph" or "the agent" collided with
the machine.

Everything the machine touches had the old name: the package, binary and config file
(`~/.config/omniralph/harness.json`, `OMNIRALPH_HARNESS_CONFIG`), the database (`harnesses` and its
five related tables, an enum, columns, constraints and `harness.*` settings), the wire protocol
(routes, JWT audience and claims, the enroll response, the Ably channel, Redis keys), the stored
playbook and run-spec keys `tools.harness` and `minHarnessVersion`, the control panel's API, pages
and copy, the release scripts and the docs.

## Decision

**Rename all of it to agent in one cutover, with no compatibility layer, and give operators an
offline `import` to carry each machine's identity across.**

### The rename, and no compatibility routes

- The package moves to `apps/agent` and is published as `@omniralph/agent` with the
  `omniralph-agent` binary. Its config is `~/.config/omniralph/agent.json`, overridden by
  `--config` or `OMNIRALPH_AGENT_CONFIG`. `update-state.json` and `update-request.json` stay next
  to it. The data directory, the repo cache, installables, caches and the Claude login stay where
  they are.
- Migration `0103_rename_harnesses_to_agents.sql` renames the tables, enum, columns, constraints and
  indexes and keeps every row (the reverse of `0055_rename_agents_to_harnesses.sql`). It renames
  the `harness.*` settings it keeps and resets version state that names `@omniralph/harness`
  versions. Migration `0104_rename_playbook_agent_keys.sql` renames `tools.harness` to
  `tools.agent` and `minHarnessVersion` to `minAgentVersion` in stored playbooks and job payloads,
  so pending jobs parse under the new agent.
- The protocol moves to `/api/agent/*`: the enroll response returns `agentId`, the JWT audience is
  `omniralph-agent` with `typ: "agent"` and an `agentId` claim on job tokens, the wake channel is
  `agent:<id>` ([ADR 0009](0009-ably-wake-signals.md)) and the Redis hot-state keys start with
  `agent-` ([ADR 0007](0007-redis-hot-state.md)).
- The control panel serves the machines under `/api/ui/agents`, `/api/ui/agent-defaults` and
  `/api/ui/agent-enrollments`, and the pages under `/agents`, `/settings/agent-defaults` and
  `/repositories/<id>/agents`.

There are no aliases for the old routes, tokens, keys or config path. Self-update can't cross a
package name, so every machine has to install `@omniralph/agent` by hand anyway, and a fallback
would only keep two names alive in the code for no machine that could use it. Tokens issued under
the old audience stop verifying at the cutover, so running jobs are drained first. Redis is a cache
that heartbeats rebuild, so cold keys are fine.

### `omniralph-agent import`

`import` reads an existing `@omniralph/harness` install's config (`--from`, else
`OMNIRALPH_HARNESS_CONFIG`, else `~/.config/omniralph/harness.json`), checks it against the agent's
config schema and writes `agent.json`, so the machine comes back as the same agent ID with its
central config, pins and audit log, without enrolling again. It prints one line per setting
(imported, default, or not imported with the reason) and never prints the refresh token.

The refresh token is the risk: if the old daemon kept running and rotated it, the agent's next
exchange would present a used token and reuse detection ([ADR 0002](0002-agent-auth.md)) would
revoke the agent. So `import` makes no network call, refuses while an `omniralph-harness` process
runs (pm2 or otherwise) and while `agent.json` exists, unless `--force`, and leaves the old install
untouched. `--dry-run` prints the summary without writing. Under pm2 it prints the commands that
replace the old process. The agent itself never reads `harness.json` or `OMNIRALPH_HARNESS_CONFIG`.
The steps are in [deploy-agent.md › Moving from @omniralph/harness](../deploy-agent.md#moving-from-omniralphharness).

### The 2.0.0 floor

`@omniralph/agent` already exists on npm: 0.3.1–0.8.0 from before the first rename, all deprecated,
with `latest` at 0.8.0. The new line starts at **2.0.0**, to match Omniralph 2.0: the package's
`version` is the never-published 1.0.0 and the epic's `major` changeset makes the first release
2.0.0, tagged `agent-v2.0.0`.

`AGENT_MIN_VERSION = "2.0.0"` (`packages/shared/src/agent-version.ts`) is a floor nothing below
passes: `scripts/agent-release.ts status` refuses to publish below it, the control panel ignores an
npm `latest` below it and refuses to save a desired version below it, and the agent never installs
one. Without it, an organization tracking `latest` would tell new agents to "update" to the
deprecated 0.8.0 until 2.0.0 is published.

### Changesets during the freeze

Other 2.0 epics keep writing `@omniralph/harness` changesets until the cutover, and
`pnpm changeset version` rejects a changeset for a package that isn't in the workspace. So:

- `scripts/check-agent-changeset.ts` accepts either package name (or an empty changeset), and
  `scripts/check-harness-changeset.ts` stays as a thin wrapper so CI's old command path keeps
  working.
- `scripts/rewrite-legacy-changesets.ts` renames the old key to `@omniralph/agent` in every pending
  changeset (keeping the larger bump when one names both). `publish-agent.yml` runs it before
  `pnpm changeset version`, so changesets written later are rewritten when the Version Packages
  pull request is built.

At the cutover, the check stops accepting the old name and the wrapper is deleted.

### Om

User-facing copy calls the AI **Om**, whether it said "Ralph", "the agent" or "the harness" before:
"Om is working on SOC-1719", "Passed this to Om while it's working.", "You are Om, Omniralph's AI"
in the chat prompt. "Agent" only ever means the machine. The Linear app and its agent, `@omniralph`
mentions and the `omniralph` MCP server stay "Omniralph". Internal names that contain "ralph"
(`packages/ralph`, `ralph_runs`, `ralph_lanes`, `ralph.*` job types, the `ralph-run` sink) keep
their names: they aren't copy. `user-facing-wording.test.ts` fails on "Ralph" or "harness" in
user-facing strings, with an allowlist for what `import` and the legacy changesets need.

## Alternatives considered

- **Keep "harness".** No rename cost, but the 2.0 terms put "agent" on the Fleet board and in the
  docs, and "harness" would stay a word only this product uses for a build agent.
- **Compatibility routes and a config fallback for old harnesses.** Old daemons can't update into
  the new package anyway, so every machine is touched once at the cutover; aliases would only add
  code paths and keep the old audience valid. A config fallback would also let an un-imported
  machine start with a token the old daemon may still rotate.
- **Re-enroll every machine.** Simpler than `import`, but it loses each agent's ID, pins, audit log
  and per-agent settings, and takes an admin per machine.
- **Continue `@omniralph/agent` at 0.9.0 or 0.14.0.** Either would sort below or next to the
  deprecated 0.x line and the old harness versions; 2.0.0 is unambiguous and matches the product.

## Consequences

- Each machine is moved by hand once at the cutover: stop the old daemon, install
  `@omniralph/agent`, `import`, start under pm2, uninstall `@omniralph/harness`. An old daemon that
  starts again afterwards revokes the agent.
- ADRs 0001–0009, the migrations and the changelog keep "harness" as history. The remaining code
  references are the old names `import` needs and the legacy changeset handling, both allowlisted.
- Epic 14 removes the legacy name from the changeset check, deletes the wrapper and deprecates
  `@omniralph/harness` on npm.
