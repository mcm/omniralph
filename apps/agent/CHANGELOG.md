# @omniralph/agent

## 2.2.0

### Minor Changes

- [#117](https://github.com/mcm/omniralph/pull/117) [`1d4082a`](https://github.com/mcm/omniralph/commit/1d4082afe23c87db34c7eebbc91739a5fce7ceef) Thanks [@omniralph](https://github.com/apps/omniralph)! - Story and request runs now run the lane repository's checks (set on its Coding card) where a playbook's verify commands ran before. The story prompt's "Checked by the Orchestrator" section lists them through the new `checks` template variable, which replaces the coding playbook's verify commands variable.

- [#117](https://github.com/mcm/omniralph/pull/117) [`3789e54`](https://github.com/mcm/omniralph/commit/3789e54066f96f26410da77d05133c4f901d7757) Thanks [@omniralph](https://github.com/apps/omniralph)! - Story jobs now carry the story's kind (`story.kind`: `fix` when the work item has one of the tracker's fix labels, else `story`), and the story prompt says it on one line under the issue line ("Kind: Fix" or "Kind: Story"), through the new `story.kind` template variable.

### Patch Changes

- [#117](https://github.com/mcm/omniralph/pull/117) [`ffe994a`](https://github.com/mcm/omniralph/commit/ffe994ac0ba9a684b47d1c1b1849bd569c12d889) Thanks [@omniralph](https://github.com/apps/omniralph)! - A repo's check or a playbook's worktree setup command that is blank or too long is now refused with "Enter a command." or "Commands can be at most 4,000 characters." instead of a generic message.

- [#117](https://github.com/mcm/omniralph/pull/117) [`c110ea0`](https://github.com/mcm/omniralph/commit/c110ea050ed12ccaa1e9d5dc63b5e2fe01f3d5ac) Thanks [@omniralph](https://github.com/apps/omniralph)! - The triage prompt and output schema let a reformatted sub-issue's `blockedBy` name work items outside the epic; Omniralph blocks it on a task's epic when that task is in another epic.

## 2.1.0

### Minor Changes

- [#115](https://github.com/mcm/omniralph/pull/115) [`4ee8e1a`](https://github.com/mcm/omniralph/commit/4ee8e1afd355ac92b0f74a5e08c8633fd07c085d) Thanks [@omniralph](https://github.com/apps/omniralph)! - Name the tracker in story and request prompts from the job's new `trackerName` (the `tracker.name` prompt variable) instead of saying "Linear".

- [#115](https://github.com/mcm/omniralph/pull/115) [`98a48cf`](https://github.com/mcm/omniralph/commit/98a48cf521e2c13acbcecfd5275554229b11e6ac) Thanks [@omniralph](https://github.com/apps/omniralph)! - The agent speaks the tracker-neutral protocol: the read-only tools are `tracker_get_issue`, `tracker_list_comments`, `tracker_search_issues` and `tracker_get_document` (served under `/api/agent/runs/{id}/tracker/*` with the `tracker:read` scope), playbooks list them under `tools.tracker` and turn them on with `toolSettings.trackerRead`, and ralph payloads carry `trackerIssueId`, `trackerProvider` and `source: "tracker"`. This release and the control panel ship together: older agents don't claim runs that use the tracker protocol.

- [#115](https://github.com/mcm/omniralph/pull/115) [`1a21627`](https://github.com/mcm/omniralph/commit/1a216273699ca76164c69540316c2b88891e9d4d) Thanks [@omniralph](https://github.com/apps/omniralph)! - Rename the Linear trigger kinds to tracker trigger kinds: `linear.delegated`, `linear.triage` and `linear.mention` are now `tracker.delegated`, `tracker.triage` and `tracker.mention`.

### Patch Changes

- [#115](https://github.com/mcm/omniralph/pull/115) [`134d321`](https://github.com/mcm/omniralph/commit/134d321daee16de4956b13bab102e2d6446e6c57) Thanks [@omniralph](https://github.com/apps/omniralph)! - Move finding Linear uploads in text out of the bundled ralph package into the Linear tracker adapter; the agent's attachment handling is unchanged.

## 2.0.2

### Patch Changes

- [#111](https://github.com/mcm/omniralph/pull/111) [`960cff4`](https://github.com/mcm/omniralph/commit/960cff4d14ff342cd7486e6c0edff1610e286ce3) Thanks [@omniralph](https://github.com/apps/omniralph)! - Report failing access-token refreshes in the heartbeat (`tokenRefresh`: since when, how many attempts, the last error and when the access and refresh tokens expire), so Fleet can warn before the agent goes offline.

- [#111](https://github.com/mcm/omniralph/pull/111) [`b1a0b67`](https://github.com/mcm/omniralph/commit/b1a0b671c30f3ea609422f1abc4ec377a85ed04f) Thanks [@omniralph](https://github.com/apps/omniralph)! - Approved worktree commands no longer inherit the agent process's `GIT_CONFIG_*` overrides, so they never see a git credential helper.

- [#114](https://github.com/mcm/omniralph/pull/114) [`43cfdc3`](https://github.com/mcm/omniralph/commit/43cfdc3ec06536ba66ed5084df9c4a0f8ac8810a) Thanks [@mcm](https://github.com/mcm)! - Record review sessions' transcripts in the control panel, send tool-call parameters up to the server's 10,000-character limit instead of cutting them at 500, open links to the control panel in a new tab, and use the updated status colors (finished is green, running is lavender, stopped is amber).

## 2.0.1

### Patch Changes

- [#105](https://github.com/mcm/omniralph/pull/105) [`02044cd`](https://github.com/mcm/omniralph/commit/02044cddf08ffb680b451675b4725bb48d6cbf1f) Thanks [@omniralph](https://github.com/apps/omniralph)! - Space consecutive setting rows in a card evenly, and keep segmented controls in a setting row at their natural width.

- [#105](https://github.com/mcm/omniralph/pull/105) [`c3ee86b`](https://github.com/mcm/omniralph/commit/c3ee86b8d2a42e6fccc18bb41e0782f1626f41b6) Thanks [@omniralph](https://github.com/apps/omniralph)! - Add a shared status indicator with an optional tooltip, and let status dots and text take extra attributes.

- [#105](https://github.com/mcm/omniralph/pull/105) [`762a95f`](https://github.com/mcm/omniralph/commit/762a95f0b5bb5bf7519a0542816f4b7b8cd40230) Thanks [@omniralph](https://github.com/apps/omniralph)! - Token inputs (such as the Packages page's) add what you typed when you Tab away or click elsewhere, not only on Enter or comma.

## 2.0.0

### Major Changes

- [#88](https://github.com/mcm/omniralph/pull/88) [`838ccb0`](https://github.com/mcm/omniralph/commit/838ccb0686107747a4f554f6e2941094490bf243) Thanks [@omniralph](https://github.com/apps/omniralph)! - Renamed the package from `@omniralph/harness` to `@omniralph/agent`, starting at 2.0.0 to match Omniralph 2.0. The binary is now `omniralph-agent`, its config is `~/.config/omniralph/agent.json` (`OMNIRALPH_AGENT_CONFIG` overrides it) and its logs are named `omniralph-agent`. Self-update can't cross the rename: on each existing machine, install `@omniralph/agent` fresh with `npm install -g @omniralph/agent`, then run `omniralph-agent import` to bring the machine back as the same agent without enrolling it again.

### Minor Changes

- [#95](https://github.com/mcm/omniralph/pull/95) [`fc0d09d`](https://github.com/mcm/omniralph/commit/fc0d09d5952889b0f8badc702c901e19e11cbc01) Thanks [@omniralph](https://github.com/apps/omniralph)! - The agent remembers what it ran: the last 200 finished attempts are kept in `<dataDir>/state/attempts.json` (0600), each labeled in the same plain words as the control panel ("Built SOC-1720", "Synced customer-portal"), and a running attempt's Claude transcript is kept in memory (the last 2,000 events, dropped 10 minutes after it finishes) for the agent's page.

- [#95](https://github.com/mcm/omniralph/pull/95) [`badf7a4`](https://github.com/mcm/omniralph/commit/badf7a4cd3effd666b2872623cacc13c7206c1d4) Thanks [@omniralph](https://github.com/apps/omniralph)! - The agent page's Capacity section sets the agent's slots, its coding and review and ask slots and the kinds of work it accepts, saved to `settings.json` through `PUT /api/settings/capacity` and `PUT /api/settings/kinds` against the revision the page read (409 with the current settings when the file changed, 400 with issues for invalid values). Left-out capacity values and kinds mean the defaults.

- [#95](https://github.com/mcm/omniralph/pull/95) [`53aaca2`](https://github.com/mcm/omniralph/commit/53aaca22853ff27f9a3688a2466c00b61333e5f1) Thanks [@omniralph](https://github.com/apps/omniralph)! - Agents report whether Claude is signed in. Every heartbeat now says whether the agent's Claude login works (signed in, signed out, or unknown when the check timed out) and where its credentials come from (the `claude` login, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or a third-party provider such as Bedrock). The account's email and organization stay on the machine.

- [#95](https://github.com/mcm/omniralph/pull/95) [`fb39d2e`](https://github.com/mcm/omniralph/commit/fb39d2ef1d8893c1bd6d9f5532ac874975d013f0) Thanks [@omniralph](https://github.com/apps/omniralph)! - See Claude's login and models, and the agent's disk usage and cached repos, on the agent's page (Claude and Storage).

- [#95](https://github.com/mcm/omniralph/pull/95) [`7f73d9b`](https://github.com/mcm/omniralph/commit/7f73d9bdd8e0e597d00fd9eba47833179684226d) Thanks [@omniralph](https://github.com/apps/omniralph)! - Set host tool paths, pin the version and update now on the agent's page (Host tools and Version).

- [#95](https://github.com/mcm/omniralph/pull/95) [`7de7518`](https://github.com/mcm/omniralph/commit/7de7518cf0495465359e25b71edc18bdc9375d35) Thanks [@omniralph](https://github.com/apps/omniralph)! - Host tool paths are set on the agent; the organization catalog is gone. The agent reads them from `settings.json` (`hostTools`) and checks every configured tool and every tool the control panel's new `requiredHostTools` (the names the organization's playbooks require) asks about: a configured path is used when it's an executable outside `blockedExecPaths`, a tool without one is looked up on the agent's `PATH`, and a configured path that is missing, not executable or blocked makes the tool unavailable. A change applies at once and is reported with an immediate heartbeat as `hostTools: { name, path, source, problem }[]`; the heartbeat response no longer carries `hostTools`.

- [#95](https://github.com/mcm/omniralph/pull/95) [`2de26eb`](https://github.com/mcm/omniralph/commit/2de26eb7783c1961b721fe5376bf2845457196b9) Thanks [@omniralph](https://github.com/apps/omniralph)! - The agent serves a local page on 127.0.0.1; `omniralph-agent ui` prints its link.

- [#95](https://github.com/mcm/omniralph/pull/95) [`961905f`](https://github.com/mcm/omniralph/commit/961905f4bdacd4c2f3ca90292820c674a8dbcf3c) Thanks [@omniralph](https://github.com/apps/omniralph)! - Machine settings move to settings.json in the agent's data directory. `acceptedTaskTypes` and `installables.allow` are read from `~/.omniralph/settings.json` (validated by one shared schema, mode 0600) and apply without a restart: the next claim and the next install use them, and a valid hand edit of the file applies within a quarter of a second while an invalid one is ignored. An `agent.json` that still has `acceptedTaskTypes` or `installables` is refused with "<key> moved to settings.json"; `omniralph-agent import` writes them into `settings.json`. `agent.json` gains an optional `ui` key (`enabled`, `port`, `allowedHosts`) for the agent page.

- [#95](https://github.com/mcm/omniralph/pull/95) [`4257a30`](https://github.com/mcm/omniralph/commit/4257a30c8f73d326b18e086b49c075099680c9b3) Thanks [@omniralph](https://github.com/apps/omniralph)! - Slots and accepted kinds are set on the agent and reported to the control panel. The agent's slots (`maxConcurrency`) and its coding and review pool limits come from `settings.json` only (the heartbeat response no longer carries `maxConcurrency` or `poolLimits`). A change applies at once: the agent re-checks what it claims (lowering a limit cancels nothing) and sends a heartbeat right away. Every heartbeat reports `local { maxConcurrency, poolLimits, versionPin, installablesAllow }`, which the control panel stores read-only and shows on Fleet.

- [#87](https://github.com/mcm/omniralph/pull/87) [`7a1b5e4`](https://github.com/mcm/omniralph/commit/7a1b5e4988b393ac73cd25b779f0bf4a535920d4) Thanks [@omniralph](https://github.com/apps/omniralph)! - The agent decides which task types it runs: set `acceptedTaskTypes` in its local config (`agent.json`, a non-empty list of `query`, `review` and `coding`; all when unset). It reports the list in every heartbeat and claim, only claims jobs of those types and only asks for the pools they run in. The control panel no longer sends accepted task types to agents that report their own, and shows them read-only.

- [#95](https://github.com/mcm/omniralph/pull/95) [`88685b5`](https://github.com/mcm/omniralph/commit/88685b5c8bde9ab7f00849b0a2df38e280cc20c5) Thanks [@omniralph](https://github.com/apps/omniralph)! - Pin a version and update now from the agent; the control panel keeps the organization's version policy. The updater's target is, highest first: a local "Update now" (`SelfUpdater.request()`, which `omniralph-agent update` reaches through `update-request.json`), the pin in `settings.json` (`update.pin`), the organization's `desiredVersion`, else none; failed versions are skipped except by "Update now", and a pin changed during the drain is applied once it ends. The heartbeat reports the pin as `local.versionPin`. The heartbeat response no longer carries `updateRequest`, and the heartbeat no longer sends `handledUpdateRequestId`.

- [#95](https://github.com/mcm/omniralph/pull/95) [`29cdde4`](https://github.com/mcm/omniralph/commit/29cdde48c8099bac9b9df7236b036719f11796b2) Thanks [@omniralph](https://github.com/apps/omniralph)! - Read and follow the agent's log on the agent page's Logs section: filter by level and text, expand a line's fields, pause the live tail, load older lines and download `agent.log`.

- [#95](https://github.com/mcm/omniralph/pull/95) [`ae14f80`](https://github.com/mcm/omniralph/commit/ae14f80f0d2f4d07ce4429104cd7c6941a9bca19) Thanks [@omniralph](https://github.com/apps/omniralph)! - See what's wrong and what the agent is doing on the agent page's Overview (status line, slots, version, Claude, disk, running and recent attempts), and open an attempt to watch its live transcript and log lines.

- [#95](https://github.com/mcm/omniralph/pull/95) [`57a5aff`](https://github.com/mcm/omniralph/commit/57a5affb9442c4da52618f31c137738d9109643b) Thanks [@omniralph](https://github.com/apps/omniralph)! - Install, update and remove packages, and edit the allow-list, on the agent's page.

- [#95](https://github.com/mcm/omniralph/pull/95) [`59b62c7`](https://github.com/mcm/omniralph/commit/59b62c7d83e627e9d17028096a2c38eaed40c74e) Thanks [@omniralph](https://github.com/apps/omniralph)! - The agent page opens in the browser: `omniralph-agent ui` now serves the Omniralph design, with the agent's name and control panel in the top bar and its sections (Overview, Logs, Capacity, Packages, Host tools, Version, Claude, Storage) in a nav that marks a problem with a dot. The page keeps itself current over the agent's live stream, polls while the stream is down, and asks to be opened again after the agent restarts.

- [#95](https://github.com/mcm/omniralph/pull/95) [`54080dc`](https://github.com/mcm/omniralph/commit/54080dccf7d526434efbe0018c49574bab315d5b) Thanks [@omniralph](https://github.com/apps/omniralph)! - The agent keeps a rotating log in its data directory. Besides stderr, it writes `<dataDir>/logs/agent.log` (directory 0700, files 0600), rotated at 10 MB keeping `agent.log.1` … `agent.log.5`, and keeps the last 2,000 lines in memory for the agent's page. Tokens, `Authorization` headers and environment maps are redacted on every target.

- [#87](https://github.com/mcm/omniralph/pull/87) [`f2b9ff1`](https://github.com/mcm/omniralph/commit/f2b9ff101e0fcb7959f51165e3e61309655a8bea) Thanks [@omniralph](https://github.com/apps/omniralph)! - The agent no longer runs the legacy `ralph.story`, `ralph.request` and `ralph.describe-pr` jobs: every repository's stories, requests and PR/MR descriptions run as coding and query runs of its tasks.

### Patch Changes

- [#93](https://github.com/mcm/omniralph/pull/93) [`0c40f35`](https://github.com/mcm/omniralph/commit/0c40f35fe41cbf90f76dcea977ceece4cff4172f) Thanks [@omniralph](https://github.com/apps/omniralph)! - Code questions report the files Om reads and its steps.

- [#88](https://github.com/mcm/omniralph/pull/88) [`88fe160`](https://github.com/mcm/omniralph/commit/88fe16096d6e91f29859b95aac37918c31975c47) Thanks [@omniralph](https://github.com/apps/omniralph)! - Add `omniralph-agent import`, which brings an `@omniralph/harness` install's config over to the agent, so the machine comes back as the same agent without enrolling again. It works offline, refuses while the old daemon runs, and never prints the refresh token. `omniralph-agent start` without a config now points to `import` when an old install's config exists.

- [#88](https://github.com/mcm/omniralph/pull/88) [`fbba946`](https://github.com/mcm/omniralph/commit/fbba9468df6acbbed370dd2043011496c2758574) Thanks [@omniralph](https://github.com/apps/omniralph)! - Never update to an `@omniralph/agent` version below 2.0.0: the agent refuses a desired or requested older version and reports why.

- [#88](https://github.com/mcm/omniralph/pull/88) [`e6eced7`](https://github.com/mcm/omniralph/commit/e6eced76b46fff9f3f6a4597ad8b8eb03624b603) Thanks [@omniralph](https://github.com/apps/omniralph)! - The agent talks to the control panel under `/api/agent/*`, with agent-named tokens (audience `omniralph-agent`), enrollment (`agentId`) and wake channel (`agent:<id>`), and reads its Omniralph tools from the run spec's `tools.agent`. It needs a control panel with the same rename: old `@omniralph/harness` installs can't talk to it.

- [#91](https://github.com/mcm/omniralph/pull/91) [`d1a22ec`](https://github.com/mcm/omniralph/commit/d1a22ecf19c68c1ddf15ddf557f5b01079bd646d) Thanks [@omniralph](https://github.com/apps/omniralph)! - Agents report their host name and Coder workspace to the control panel.

- [#95](https://github.com/mcm/omniralph/pull/95) [`b88a9e6`](https://github.com/mcm/omniralph/commit/b88a9e6f4f0da634163ca2ad7ddd52e417f955ef) Thanks [@omniralph](https://github.com/apps/omniralph)! - Agents measure what they store and keep track of their repos. They size the repo cache, worktrees, branch worktrees, packages, caches and logs, read the free space of each disk they write to (low under 5 GB or 10 % free), and list each cached repo with its size, last fetch, last sync and whether it's pinned to the agent. The heartbeat response now names pinned repositories by provider and path. The agent page will show all of this.

- [#97](https://github.com/mcm/omniralph/pull/97) [`dfaff9e`](https://github.com/mcm/omniralph/commit/dfaff9e1da1db7a035ebd61afedc8ef14a334004) Thanks [@omniralph](https://github.com/apps/omniralph)! - Report token usage per model, with cache reads and writes.

- [#87](https://github.com/mcm/omniralph/pull/87) [`a75979c`](https://github.com/mcm/omniralph/commit/a75979c200525112dab3de055e2293fd8ff92f4d) Thanks [@omniralph](https://github.com/apps/omniralph)! - A run's model and token budget come from one place. A review takes both from its review depth; every other run takes the task's model, else the agent's, else the Claude Code default, and the task's fixed token budget or no limit. A task's token budget is now `{ tokens }` or `null` ("No limit"): `profileFraction` is gone, and review tasks can't set a model or budget. The built-in `ask-about-code`, `correlate-findings`, `reply-to-finding` and `learn-rule` tasks set `claude-sonnet-5-5` and fixed budgets (50,000, 100,000, 20,000 and 5,000 tokens), so their runs keep today's model and budget.

- [#87](https://github.com/mcm/omniralph/pull/87) [`1703496`](https://github.com/mcm/omniralph/commit/17034967b8dba1e4dbc9d27ba85c48036c20dd03) Thanks [@omniralph](https://github.com/apps/omniralph)! - Agent and task definitions are merged into playbooks: one recipe per kind of run (role, prompts, model, tools, requirements). The control panel still sends each run as an agent and a task, built from the playbook, so runs work as before. The run spec's agent no longer has task types or skills; fields the agent doesn't know are passed through.

- [#87](https://github.com/mcm/omniralph/pull/87) [`aae1297`](https://github.com/mcm/omniralph/commit/aae129773fb56bc5f93957f22e2014d6fcb53b24) Thanks [@omniralph](https://github.com/apps/omniralph)! - A task definition no longer has a `pool`: a job's pool follows from its task type (`long` for coding runs, `short` for query and review runs). Claims still report each job's pool, so the agent's per-pool slot accounting is unchanged.

- [#87](https://github.com/mcm/omniralph/pull/87) [`4ac6f41`](https://github.com/mcm/omniralph/commit/4ac6f41925c0d23dc09afd192c237fa2516efa9a) Thanks [@omniralph](https://github.com/apps/omniralph)! - Coding runs take their worktree setup command, model and fallback model from the story or request playbook in the run spec, falling back to the job's settings when the control panel predates them. Coding playbooks gain verify commands, a worktree setup command, PRD quality gates, preparation, the epic's completed state and branch cleanup settings, and their review and CI fix rounds default to 3.

- [#87](https://github.com/mcm/omniralph/pull/87) [`60b11ea`](https://github.com/mcm/omniralph/commit/60b11ea9b25de4b2b049b3a43dead0431c2a4ad4) Thanks [@omniralph](https://github.com/apps/omniralph)! - A repository's review, correlation, story and request settings now name playbooks (`reviewPlaybookIds`, `correlationPlaybookId`, `storyPlaybookId`, `requestPlaybookId`), and each may be left out of a settings save to keep it. Nothing changes for the agent.

- [#87](https://github.com/mcm/omniralph/pull/87) [`67518e1`](https://github.com/mcm/omniralph/commit/67518e14417fd1183bd4ec4275d8b4f3e389b704) Thanks [@omniralph](https://github.com/apps/omniralph)! - Reviews run at a review depth (Quick, Standard or Deep) instead of an editable review profile. `@omniralph/shared` exports the presets as `REVIEW_DEPTHS`; a review's `reviewConfig.profile` now carries its depth's preset, so the agent's review lifecycle is unchanged. Posted review summaries say **Depth** instead of **Profile**.
