# Linear (ralph)

The `ralph` capability builds Linear issues: delegate an epic (or a single issue) to the Omniralph
Linear app and the control panel runs it story by story on an agent, one `ralph.story` job per
story, then opens a pull/merge request to the repository's default branch. See
[ADR 0003](adr/0003-ralph-orchestration.md) for how the loop is orchestrated.

The control panel is the only thing that talks to Linear. It holds the app's tokens (encrypted with
`ENCRYPTION_KEY`, refreshed automatically when they're within 5 minutes of expiry), receives
Linear's webhooks and posts the agent session's plan, thoughts, actions and responses. Agents relay
their activities through the control panel (`POST /api/agent/jobs/{id}/activities`) and never see
a Linear token.

Setting ralph up takes five steps:

1. [Create the Linear OAuth app](#1-create-the-linear-oauth-app).
2. [Set the env vars](#2-set-the-env-vars) on the control panel.
3. [Connect the workspace](#3-connect-from-settings--integrations) from **Settings › Integrations**.
4. [Enable ralph and configure routing](#4-configure-routing) on a repository, and enable the
   `ralph` capability on an agent ([deploy-agent.md](deploy-agent.md#ralph)).
5. [Delegate an issue](#5-delegate-an-issue).

The code host needs the write permissions described in [github-app.md](github-app.md) (Contents and
Pull requests: Read and write) or [gitlab.md](gitlab.md) (`api` and `write_repository`).

## 1. Create the Linear OAuth app

In Linear, as a workspace admin, open **Settings › API › OAuth applications › New** (one app per
control panel; a preview deployment that should build issues needs its own app):

| Field | Value |
| -- | -- |
| Name | `Omniralph` (shown as the agent's name in Linear) |
| Callback URLs | `<APP_URL>/api/integrations/linear/callback` |
| Webhooks | On, URL `<APP_URL>/api/webhooks/linear` |
| Webhook events | **Agent session events** and **Issues** (nothing else is needed) |

Save, then copy the **client ID**, **client secret** and the webhook's **signing secret**.

You don't pick the actor or scopes on this page: **Connect Linear** requests them when installing.
The app is installed with `actor=app` (it acts as its own workspace member, not as the admin who
installed it) and the scopes `read,write,app:assignable,app:mentionable`. `app:assignable` is what
lets people delegate issues to it; `app:mentionable` lets them @mention it.

The webhook is verified with the HMAC-SHA256 `Linear-Signature` header. Deliveries whose
`webhookTimestamp` is more than 60 seconds off are rejected (keep the clock in sync if you run the
control panel yourself), and redelivered events are deduplicated.

## 2. Set the env vars

On the Vercel project (per environment; [env.md](env.md#linear-app-ralph)):

| Variable | Value |
| -- | -- |
| `LINEAR_CLIENT_ID` | The app's client ID |
| `LINEAR_CLIENT_SECRET` | The app's client secret |
| `LINEAR_WEBHOOK_SECRET` | The webhook signing secret |

Redeploy afterwards. Without the client ID and secret, **Connect Linear** is disabled. Without the
webhook secret, every Linear webhook is rejected.

## 3. Connect from Settings › Integrations

As an admin, open **Settings › Integrations** and click **Connect Linear**. Linear shows its consent
screen for the workspace you're signed in to; approve it and you return to the Integrations page,
which then shows the connected workspace. Finish within 10 minutes of clicking (the sign-in link
expires) and from the same browser.

- One Linear workspace can be connected at a time. Webhooks from any other workspace are ignored.
- **Disconnect** deletes the stored tokens. Runs can't advance (their stories are re-read from
  Linear before each one) until Linear is connected again. Stopping a run from **Ralph runs** still
  works.
- To move to another workspace, disconnect, then connect again while signed in to the other one.

## 4. Configure routing

Ralph only builds in repositories that opted in. On **Repository › Settings › Ralph**:

| Setting | What it does |
| -- | -- |
| **Enable ralph** | Delegated issues may build in this repository and push branches to it. Off by default. |
| **Linear labels** | Comma-separated label names. Issues with any of them route here. |
| **Linear projects** | Comma-separated project names. |
| **Linear team keys** | Comma-separated team keys, e.g. `ENG`. |
| **Open the pull request early** (`openPullRequestEarly`) | Open a draft PR/MR after the first story is pushed, update it as stories land and mark it ready at the end. Off: the PR/MR is opened when every story is done. |

The rest of the section holds cyralph's per-repository settings (`repositories[]` in cyralph's
config), with the same names and defaults, grouped as on the page:

| Group | Setting | Default | What it does |
| -- | -- | -- | -- |
| Verification | **Verify commands** (`verifyCommands`) | none | One per line. The story job runs them as quality gates after the session reports a story complete; a failing one sends its output back for the next attempt. |
| Verification | **Run the PRD's quality gates** (`runPrdQualityGates`) | on | Also run the PRD's `## Quality Gates` commands, after the verify commands (each command runs once). A single issue has no PRD and only runs the verify commands. |
| Verification | **Setup command** (`setupCommand`) | none | Run once in a fresh branch worktree before the first story, e.g. `pnpm install --frozen-lockfile`. |
| Prompt and model | **Appended instruction** (`appendInstruction`) | none | Text appended to every story (and request) prompt. |
| Prompt and model | **Model** (`model`) / **Fallback model** (`fallbackModel`) | `opus` / none | The Claude model alias or ID the sessions use, and the one used when it's overloaded. |
| Tools | **Allowed tools** (`allowedTools`) | none | Agent SDK tools or permission rules, one per line (`Read`, `Bash(pnpm test:*)`). Empty: ralph's whole tool policy. Otherwise only these tools are available and only calls matching them run (the session switches from `bypassPermissions` to `dontAsk`). They can only narrow ralph's policy. |
| Tools | **Disallowed tools** (`disallowedTools`) | none | Always denied, on top of ralph's policy. |
| PR follow-up | **History rewrites** (`historyRewrite`) | `when-asked` | `when-asked` or `never`: whether a request may rebase and push with `--force-with-lease`. |
| PR follow-up | **Fix review findings** (`respondToReviews`) / **Max review rounds** (`maxReviewRounds`) | on / 3 | Omniralph's review findings and `@bot` requests on the run's PR/MR become requests, for at most this many reviews. |
| PR follow-up | **Fix failed CI** (`respondToCiFailures`) / **Max CI fix rounds** (`maxFixRounds`) | on / 3 | A failed CI run on the PR/MR's head commit becomes a request, at most this many times. |
| PR follow-up | **Clean up after the merge** (`cleanupMergedWorktrees`) / **Unmerged branch timeout** (`unmergedBranchTimeoutMinutes`) | on / 60 | Remove the worktree and local branch after the merge; a branch with unmerged commits is deleted after this many minutes without an answer. |
| Linear | **Manual labels** (`manualLabels`) | `manual` | Comma-separated Linear labels that mark a story as a step for a person (at least one). Matching ignores case. The first label is the one ralph puts on the manual stories it creates (from a PRD's `**Labels:** manual` stories, and follow-ups that need a person), so make it a label that exists in your Linear workspace. |
| Linear | **Offer to run preparation** (`allowPreparation`) | on | Ask whether to run a manual story's `cyralph-prepare` commands ("Run it"). Off: the blocks are plain text and nothing is offered. |
| Linear | **Epic completed state** (`epicCompletedState`) | none | When every story of an epic (not a single issue) is complete, move the epic to this state: a state name (e.g. `In Review`), or `started` / `completed` for the first state of that type. Applied after the PR/MR step, even if it failed; a Linear error is only logged. |

The review, CI, cleanup and history-rewrite settings are stored and editable, but ralph doesn't act
on them yet: the request mode and PR follow-up behind them are still to come.

Settings are read whenever a run makes its next decision or enqueues its next job, so changing them
also changes running epics from their next story on (for example which stories are manual).

A delegated issue is routed to the first repository that matches, trying these rules in order:

1. a `[repo=<fullPath>]` tag in the issue's (or epic's) description, e.g. `[repo=acme/web]` or
   `[repo=group/subgroup/project]`. A tag is authoritative: an issue tagged with a repository that
   doesn't have ralph enabled isn't routed by its labels, project or team.
2. one of the issue's labels in a repository's **Linear labels**
3. the issue's project in a repository's **Linear projects**
4. the issue's team key in a repository's **Linear team keys**

Matching ignores case, and only repositories with ralph enabled are candidates. When several
repositories match the same rule, the one whose path sorts first wins, so avoid overlapping routes:
use labels or tags for the exceptions and a team key for the default. An issue that routes nowhere
gets an error response in its agent session explaining how to route it; nothing is built.

Don't route the same team, project or label to both Omniralph and cyralph
([deploy-agent.md](deploy-agent.md#coexisting-with-cyralph-and-manual-dev-work)).

## 5. Delegate an issue

Set an issue's **Delegate** (or assignee, depending on the Linear version) to the Omniralph app. The
agent session acknowledges within seconds, then the run starts. What gets built depends on the
issue:

| Delegated issue | Run kind | Stories |
| -- | -- | -- |
| An epic with sub-issues | `children` | Each open sub-issue is a story. |
| An issue whose description is a PRD (`### US-001: …` story headers with **Acceptance Criteria**, or a `prd.json` block) and has no sub-issues | `prd` | The PRD's stories are first materialized into sub-issues (with priorities, order and "blocks" relations), then built as `children`. |
| A sub-issue of an epic | `children`, focused | The parent epic is loaded and the delegated story runs first. |
| Any other issue | `single` | The issue itself is the only story. |

How the run behaves:

- **Branch.** A `> Branch: <name>` line in the epic's description, else Linear's branch name for the
  issue. The base is the repository's default branch. Every finished story is committed as
  `feat(<STORY-ID>): <title>` (`<ISSUE-ID>: <title>` for a single issue) and pushed.
- **Quality gates.** The commands under the epic description's `## Quality Gates` heading run after
  every story; a failing gate fails the attempt.
- **Order.** Stories in progress first, then by Linear priority, then sub-issue order. A story waits
  while it's blocked by an open issue. A failed, incomplete or blocked attempt is retried with
  feedback up to 3 times, then the story is marked exhausted and later independent stories still
  run.
- **Manual stories.** Sub-issues labelled with one of the repository's **Manual labels** (`manual`
  by default) are for a person: the run waits for them to be
  completed. A manual story's description may contain a ` ```cyralph-prepare ` block of shell
  commands, one per line; when the story becomes unblocked the session asks **Run it** / **I'll do
  it myself** / **Not yet**, and **Run it** runs them on the agent in the branch worktree.
- **Waiting.** When no story is ready the run waits and says on what. It resumes by itself when a
  blocking issue or manual story is completed in Linear.
- **Follow-ups** reported by a story are filed as sub-issues of the epic (labelled with the first
  **Manual label** when they need a person).
- **The end.** When every story is done, an agent writes the PR/MR title and body, the control panel
  opens it (or updates the open one) and marks it ready, links it to the agent session and posts a
  final response.

Reply in the agent session to steer a run:

| Reply | Effect |
| -- | -- |
| `stop` (or Linear's stop button) | Stops the run and cancels its running job. A later `rerun preparation`, `start anyway` or guidance reply resumes it. |
| An answer to the preparation question | `Run it` / `I'll do it myself` / `Not yet` (or `1`–`3`). |
| `rerun preparation` | Asks the preparation question again. |
| `start anyway` | Ignores the open blockers and continues. |
| Anything else | Stored as guidance for the next story attempts; exhausted stories get fresh attempts. |

A reply is applied from the next story attempt; it doesn't reach a session that's already running.

An @mention of the app that isn't a delegation gets a response that only delegation is supported.

Every run, its stories, attempts, commits, jobs, agent and PR/MR are listed under **Ralph runs**,
where admins can also stop a run.

## Troubleshooting

- **The session never acknowledges.** Check the webhook URL, that **Agent session events** is
  enabled, `LINEAR_WEBHOOK_SECRET` (a mismatch gives 401 in the function logs) and that the
  workspace is the connected one.
- **Runs don't resume after a blocker is done.** **Issues** webhook events are disabled. The
  `/api/cron/ralph-reconcile` cron (every 10 minutes) still catches up waiting runs.
- **"No repository with ralph enabled is routed to it".** Enable ralph on the repository and add the
  issue's label, project or team to its routing, or tag the issue with `[repo=<path>]`.
- **Stories fail to push.** The code host credentials lack write access: see
  [github-app.md](github-app.md) and [gitlab.md](gitlab.md).
- **No agent picks the job up.** No agent has the `ralph` capability enabled, or the repository is
  pinned to an agent that doesn't ([deploy-agent.md](deploy-agent.md#ralph)).
