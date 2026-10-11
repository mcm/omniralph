# Linear (ralph)

The `ralph` capability builds Linear issues: delegate an epic (or a single issue) to the Omniralph
Linear app and the control panel runs it story by story on an agent, one `ralph.story` job per
story, then opens a pull/merge request to the repository's default branch. See
[ADR 0003](adr/0003-ralph-orchestration.md) for how the loop is orchestrated.

The control panel is the only thing that talks to Linear. It holds the app's tokens (encrypted with
`ENCRYPTION_KEY`, refreshed automatically when they're within 5 minutes of expiry), receives
Linear's webhooks and posts the agent session's plan, thoughts, actions and responses. Agents relay
their activities through the control panel (`POST /api/harness/jobs/{id}/activities`), download
[Linear attachments](#attachments) through it (`GET /api/harness/jobs/{id}/attachments/{attachmentId}`)
and never see a Linear token.

Runs can also start from a Slack or Discord thread: a linked member asks the chat bot and it hands
the request to a request-mode run in a ralph-enabled repository, whose progress, answers and PR/MR
follow-ups go to that thread instead of a Linear session. Such runs need no Linear issue (or
Linear connection) and don't change anything in Linear; see
[chat.md › Ralph from chat](chat.md#ralph-from-chat). Linear runs behave as described here, and
the chat bot can also report on them and send them guidance.

The `triage` capability uses the same app to rewrite rough issues as PRDs ralph can build: see
[Triage](#triage).

Coming from cyralph? [cutover-from-cyralph.md](cutover-from-cyralph.md) maps its `config.json` to
the settings below and lists the steps to switch over.

Setting ralph up takes five steps:

1. [Create the Linear OAuth app](#1-create-the-linear-oauth-app).
2. [Set the env vars](#2-set-the-env-vars) on the control panel.
3. [Connect the workspace](#3-connect-from-settings--integrations) from **Settings › Integrations**.
4. [Enable ralph and configure routing](#4-configure-routing) on a repository, and enable the
   `ralph` capability on an agent ([deploy-harness.md](deploy-harness.md#ralph)).
5. [Delegate an issue](#5-delegate-an-issue).

The code host needs the write permissions described in [github-app.md](github-app.md) (Contents and
Pull requests: Read and write) or [gitlab.md](gitlab.md) (a service account's token with `api`,
Maintainer on the project).

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

As an admin of the Omniralph organization that should use the workspace, open **Settings ›
Integrations** and click **Connect Linear**. Linear shows its consent
screen for the workspace you're signed in to; approve it and you return to the Integrations page,
which then shows the connected workspace. Finish within 10 minutes of clicking (the sign-in link
expires) and from the same browser.

- The Linear workspace is connected **per organization**: each organization connects at most one
  workspace, and a workspace belongs to one organization. Connecting a workspace that another
  organization already has is refused ("This Linear workspace belongs to another organization");
  disconnect it there first. Webhooks are routed to the organization that connected the
  workspace and ignored for workspaces no organization connected.
- Runs, routing and ralph's repositories are per organization too: a delegated issue is only
  routed to repositories of the workspace's organization, and its jobs only go to that
  organization's agents. Only its members see the runs under **Ralph runs**.
- **Disconnect** deletes the stored tokens. Runs can't advance (their stories are re-read from
  Linear before each one) until Linear is connected again. Stopping a run from **Ralph runs** still
  works.
- To move to another workspace, disconnect, then connect again while signed in to the other one.
  To move a workspace to another organization, disconnect it in the first and connect it from the
  second (runs stay with the organization that started them).

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
use labels or tags for the exceptions and a team key for the default.

An issue that routes nowhere gets a question in its agent session: "Which repository should I work
in for this issue?", with every ralph-enabled repository as an option. Nothing is built until you
answer. A reply matches the option number (`1`, `2`, …), a repository's full path, its last path
segment (`web` for `acme/web`), or any text that contains a full path; anything else asks again.
The run detail page shows the repository as "Not chosen yet" meanwhile.

Routing runs again whenever the issue is delegated again:

- A repository someone picked stays, even when routing would now choose another one.
- When routing would have to ask, the previous run's repository stays.
- When routing now chooses another repository (for example, a new `[repo=…]` tag), the new run
  works there on a new branch, and the agent session says that the earlier branch and PR/MR stay
  as they are.

If no repository has ralph enabled at all, the session gets an error explaining how to enable one.

**Stories in other repositories.** In an epic with sub-issues, each story is also routed on the
signals it doesn't share with the epic, in the same order: its own `[repo=…]` tag, a routing
label, a project other than the epic's, a team other than the epic's. A story without any stays
in the epic's repository. A story routed to another ralph-enabled repository gets a lane there:
its own branch (the epic's branch name, based on that repository's default branch) and its own
PR/MR, and the run's start message says so. A story whose tag or project matches no
ralph-enabled repository is treated like a manual step ("isn't in a repository I have"), shown as
"(manual: no repository here)" in the plan: nothing is built for it, and stories that depend on it
wait until a person completes it. Teams and labels often span repositories, so an unknown one
never makes a story manual. The run detail page shows one section per repository with its branch,
PR/MR and stories.

Each story's job runs in its lane: that repository's checkout, branch and base branch, its ralph
settings (model, tools, prompt additions, setup command) and its quality gates (its
`verifyCommands`, plus the PRD's gates when its `runPrdQualityGates` is on), on the run's agent.
The prompt names the repository. When every story is done, each lane is published in turn: a
lane no story committed to (every story went elsewhere) gets no PR/MR; every other lane gets its
own description job and its own PR/MR, and `openPullRequestEarly` follows each repository's own
setting. If a lane's PR/MR step fails, the others still go ahead; the problems, prefixed
"In `<repo>`:", are collected into one question saying what didn't happen, and the run waits until
a reply retries the lanes that failed. The final response lists every PR/MR, labelled by repository
when there is more than one, and each is added to the agent session's links.

Don't route the same team, project or label to both Omniralph and cyralph: move them over one at
a time as described in [cutover-from-cyralph.md](cutover-from-cyralph.md).

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
- **Quality gates.** The repository's **Verify commands**, then (with **Run the PRD's quality
  gates** on) the commands under the epic description's `## Quality Gates` heading, run after
  every story; a failing gate fails the attempt. A single issue runs the verify commands only.
- **Order.** Stories in progress first, then by Linear priority, then sub-issue order. A story waits
  while it's blocked by an open issue. A failed or incomplete attempt is retried with feedback up
  to 3 times, then the story is marked exhausted and later independent stories still run.
- **Blocked stories.** A story whose session reports it blocked is set aside at once (no retries
  until someone replies); independent stories still run. If it left changes and the story's quality
  gates pass, they are committed as `wip(<STORY-ID>): <summary>` and pushed, recorded on the story
  and in the progress log; otherwise they are stashed and offered to its next attempt. A blocked
  story that files blocking follow-ups waits for them instead.
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
| `/continue` | Resets the per-run iteration cap (50 story attempts), so the run keeps going. On its own, it continues without guidance (unfinished stories get fresh attempts); anything after `/continue` is handled as a reply of its own (usually guidance). |
| Anything else, while a story or request runs | Passed to the agent that's working right now (within one heartbeat, about 20s): it answers in the same session, and later stories get the reply as guidance too. If the session can't take it (e.g. the story is running its quality gates), it becomes guidance for the next story attempt (a pending request in request mode). A reply asking to push or open/update a PR/MR (cyralph's pattern: `push`, `pull request`, `merge request`, `PR`, `MR`, `gh`, `glab`) never goes to a story agent: it is kept as a pending request. |
| Anything else | Stored as guidance for the next story attempts (exhausted stories get fresh attempts) and as a pending request. When the next story starts, it takes the reply (push/PR requests excepted). When no story runs (every story is done, or the run waits on blockers), it runs as a **request** (below). A reply to a run waiting after its PR/MR step failed only retries that step. |
| `/ralph` | Switches a mention's run (request mode) to the story loop; its requests become guidance. |
| `/ship [notes]` | Ships the branch's work with a `ralph.request` job once nothing else runs (in an epic, once no story runs). The session brings earlier request sessions' stashed work back if it belongs, does what the notes ask, runs the quality gates and writes the commit message; then the job itself commits everything, pushes the branch and, when the lane has no PR/MR yet, opens one. Git runs outside Claude Code, so a repository whose `.claude/settings.json` asks before `git commit`/`git push` can still ship. Never passed to a running session, never story guidance. |
| `Allow` / `Deny` (or `yes` / `no`) | Answers a request session's permission question (below). |

**Permission questions.** Request sessions skip Claude Code's permission prompts, except for calls
a repository's own Claude Code settings `ask` about (for example `"ask": ["Bash(git commit:*)"]` in
a committed `.claude/settings.json`). Such a call is asked about in the agent session as an
**Allow** / **Deny** picker. The session waits for the answer, which reaches the agent within a few
seconds. With no answer in 30 minutes the call is denied and the session carries on without it. Story
sessions never ask (an epic must never wait for a person): such calls are denied there.

Live delivery needs an agent version that acknowledges `jobMessages`; with an older agent, the reply is applied from the next story attempt once the running job ends.

A reply on a finished (completed) run reopens it: the reply runs as a request in that session.

### @mentions (request mode)

@mention the app in an issue's comments to ask for something specific ("push this and open the
MR", "rebase on main", "what's left on this epic?"): like Cyrus, Omniralph does just that, with the
epic as context. The mention's text (without a leading `@name`) is the request.

- **No story loop.** A mention never builds stories, never changes the issue's state in Linear and
  ignores blockers. Add `/ralph` to the mention (or a later reply) to build the epic instead, with
  the rest of the comment as guidance.
- **One session per request.** A `ralph.request` job runs one Claude session in the branch worktree
  of the issue's run (the branch, lanes, PR/MR, stashes and guidance of an earlier run carry
  over). Its prompt has the epic's status and stories, the PR/MR, the progress log, the quality
  gates and the PRD. It may commit and push the run's branch (never another one: the agent's
  `pre-push` hook rejects that), and rebase and `--force-with-lease` it when asked, unless the
  repository's **History rewrites** setting is `never`.
- **PRs/MRs.** The agent never runs `gh` or `glab`: it asks for a PR/MR change in its result, and
  the control panel makes it (opens it as a draft, updates its title or description, or marks it
  ready), sanitizing the agent's text. An open PR/MR for the branch is adopted.
- **Follow-ups.** Replies in the mention's session are new requests; they continue the same Claude
  conversation when they run on the same agent.
- **Uncommitted changes** the session leaves are stashed, and the response says so.
- **Busy issue.** A mention on an issue whose run is working right now is passed to that agent
  ("Passed this to the agent that's working on this epic right now; it will answer in that
  session."); one whose run waits is added to that run as a request.
- A mention without a request does nothing.

### Reviews and `@bot` requests on ralph PRs/MRs

Omniralph looks after the PRs/MRs its runs open (cyralph's review-response loop):

- **Its own reviews.** When an Omniralph review (`review.run`) of a run's PR/MR completes against
  the PR/MR's current head, its open findings (not dismissed) become one request on that lane:
  each finding's `path:line`, severity, title, body (up to 1,500 characters) and suggested
  change, at most 25 of them. The agent fixes the ones that are right, runs the quality gates,
  commits and pushes the branch, and never replies to or resolves the threads. Each review is
  acted on at most once; a review of an older head is recorded and skipped, and one without open
  findings does nothing. After **Max review rounds** (`maxReviewRounds`, default 3) the session
  says "Omniralph reviewed `<url>` again. I've already worked through N of its reviews on this
  pull request, so I'm leaving this one for a person." Turn it off with **Fix review findings**
  (`respondToReviews`). A stopped or failed run is left alone; a completed one reopens.
- **Delivery.** If a `ralph.request` job is working in that lane right now, the request is passed
  to its live session ("… Passing it to the agent that's working right now."). Otherwise it's a
  pending request ("… Working through it.", or "… I'll work through it as soon as the current
  step finishes."), run as a `ralph.request` job once nothing else runs. A running story agent
  never gets it: story agents don't push, so it waits for the story loop to finish.
- **People's requests.** On a ralph PR/MR, from users with write access, `@omniralph fix [text]`
  (anywhere; in a finding's thread it includes that finding) and any other `@omniralph` text
  outside finding threads become requests on that lane, delivered the same way; a stopped or
  finished run resumes. The bot replies in the thread with a link to the Linear issue.
  `review`, `review fresh`, `dismiss`, `help` and questions in finding threads work as before. On
  PRs/MRs ralph didn't open, `@omniralph fix` replies that it only works on ralph PRs/MRs.
- **Failed CI.** When the CI of a ralph PR/MR's head commit finishes and fails (GitHub Actions
  workflow runs, GitLab pipelines), the failed jobs and the last 4,000 characters of each log
  (at most 5 jobs, then "(N more failed jobs not shown.)"; "(no log available)" when a log can't
  be read) become a request on that lane, and the session says "CI failed on the pull request
  (`<sha7>`: `a`, `b`, `c` and N more). Working on a fix." The agent fixes the cause (not by
  weakening tests or checks; a flaky or infrastructure failure is reported, not "fixed"), runs
  the quality gates and pushes. It's noticed from GitHub `workflow_run` and GitLab **Pipeline
  events** webhooks, and by `/api/cron/ralph-reconcile`, which checks every open ralph PR/MR.
  Each head commit is acted on once; after **Max CI fix rounds** (`maxFixRounds`, default 3) the
  session says "CI failed again on `<url>` (`<sha7>`). I've already tried to fix CI N time(s) on
  this pull request, so I'm leaving this one for a person." A run with a job queued or running is
  checked again later (it may push again); stopped runs and repositories with **Fix failed CI**
  (`respondToCiFailures`) off are skipped, and a closed or merged PR/MR is no longer followed up.
- **Cleanup after the merge.** When a ralph PR/MR merges (its merge webhook: GitHub
  `pull_request` closed + merged, GitLab **Merge request events** `merge`; the Linear issue moving
  to a completed state; or `/api/cron/ralph-reconcile`, which checks every open ralph PR/MR), a
  `ralph.cleanup` job on the run's sticky agent stashes the worktree's uncommitted changes, removes
  the branch worktree, and deletes the local branch unless it has commits the merged head doesn't
  (remote branches are never deleted). It waits while one of the run's jobs is queued or running.
  The session then says "The pull request `<url>` was merged, so I removed its worktree and the
  local branch `b`." (or "…but kept the local branch `b`.", plus "Its uncommitted changes are
  stashed (`sha`)." when there were some), as a thought while the run is active, otherwise as a
  response. Leftovers are asked about with select questions, stored on the lane (they survive
  restarts and deploys):
  - the run's stash entries nobody applied: **Push to a branch on origin** (one commit per entry
    on `ralph/stash/<epic>`, then dropped) or **Drop**; they stay until someone answers;
  - a kept branch: **Push to origin** (pushed, then deleted) or **Delete**. Without an answer
    within **Unmerged branch timeout** (`unmergedBranchTimeoutMinutes`, default 60) the cron
    deletes it and says "Nobody answered within M minutes, so I deleted the local branch…".

  Answers are matched as in cyralph: the option's text (newest question first), `1`/`2` when only
  one question is open, or a short reply with a unique first word ("drop", "delete"). A reply
  that isn't an answer is handled as usual. When an answer can't be carried out the session says
  "I couldn't do that (…): … Answer again to retry." Turn **Clean up after the merge**
  (`cleanupMergedWorktrees`) off to keep worktrees and branches; a PR/MR closed without merging is
  left alone. The lane's cleanup state is shown on the run's page.

### Attachments

Files uploaded to Linear (pasted screenshots, mockups, PDFs: `https://uploads.linear.app/...`
links) reach the agent, as in cyralph:

- **Where they're found.** The epic's description and comments, every story's description, the
  comments of stories that aren't done, and the thread (guidance and pending requests, listed as
  "Linear thread"). Linear's `<linear-image>` blocks, markdown links and images, and bare URLs all
  count; the signed `?signature=…` part is dropped and each file is listed once.
- **Scope.** A file referenced by a story (or its comments) only goes to that story's job; files of
  the epic and the thread go to every story. A `ralph.request` job gets all of them.
- **Download.** Job payloads list them by ID (`{ id, title, sources }`). The agent downloads each
  through the control panel with its job token (scope `ralph:attachments`, only for attachments in
  that job's payload); the control panel fetches it from Linear with its own token and streams it
  back. HTML pages (a sign-in page instead of the file) and files over 25 MB are rejected.
- **Cache.** The agent keeps them in `<workspaceRoot>/.attachments/<EPIC>/` (indexed in
  `.index.json`), downloads at most 20 new files per job, names them after their Linear title (or
  `attachment-N`, with an extension from the content type) and lets the session read that folder.
- **Prompt.** Each file is listed with where it came from and its local path; the session opens
  them with the Read tool (which shows images). A file that couldn't be downloaded is listed as
  such ("Don't guess what it shows"), and the agent says so once in the session as a thought.

Every run, its stories, attempts, commits, jobs, agent and PR/MR are listed under **Ralph runs**,
where admins can also stop a run. A run's page has one section per repository (lane) with its
branch, PR/MR, stories, review rounds and CI fix rounds (out of the repository's `maxReviewRounds`
/ `maxFixRounds`, or "off" when that loop is turned off) and cleanup state. Below them are
**Pending requests** (requests from Linear, review findings, `@bot` comments and failed CI the
run hasn't handled yet, with their repository, author and time), **Messages** (the latest 50
replies passed to a running job's live session, newest first: kind, text, author, job, and
whether the agent's heartbeat delivered it, it's still waiting, or it couldn't be delivered and
was kept as guidance), the run's guidance, its progress log and its jobs. **Analytics**
has a Ralph section: runs started, ralph tokens per day next to reviews, runs per day by status
and story outcomes per day and in total (first attempt, after retries, blocked, exhausted).

## Triage

The `triage` capability turns a rough Linear issue into something ralph can build, without a
person in the loop: it does what the `/linear-prd triage` skill does interactively. It reads the
issue (and, read-only, the repository it routes to), rewrites it as a PRD in the format ralph
executes, splits large work into sub-issues and lists whatever it couldn't decide as open
questions. It never writes code, branches, commits or PRs/MRs.

**Setup** (once, on top of steps 1–3 above):

- Enable the `triage` capability on an agent under **Agents › <agent>** (**Enabled
  capabilities**; it applies with the next heartbeat). Triage jobs (`triage.run`) wait in the
  queue until an agent has it.
- For the label trigger, create a label named `ralph:triage` in the Linear workspace (a
  workspace label, or one on each team that should use it). The app's **Issues** webhook events
  (step 1) deliver the label changes.

### Starting triage

- **Mention.** @mention the app with `/triage` in an issue's comment, e.g. `@omniralph /triage`
  (the rest of the comment is passed along like a reply). A mention without `/triage` is a ralph
  request, as before.
- **Label.** Add the `ralph:triage` label to an issue (the name matches ignoring case). The control
  panel opens an agent session on the issue itself, so the label trigger gets the same activities
  and reply handling as a mention. The label is removed when triage finishes (or fails, is stopped
  or can't start), so adding it again triages again. Adding the label in the same edit as a state
  change (a bulk edit, or moving the issue to Backlog and labelling it at once) works too.

One triage runs per issue at a time: the label on an issue that is being triaged does nothing,
and a mention or reply from another session is answered that the issue is being triaged in
another session. Triage reports in the session like ralph does: an "On it…" thought, a "Triaging …" thought naming the repository it reads, and a
final response with what changed (outcome, size, structure, sub-issues created or updated, the
status set and the open questions).

### Repository and session

The issue is routed with ralph's rules ([4. Configure routing](#4-configure-routing): `[repo=…]`
tag, labels, project, team; only ralph-enabled repositories). With a repository, the agent checks
out its default branch and the PRD's quality gates and file paths come from the source (CI config
first, and the repository's `LINEAR.md` if it has one). Without one, triage still runs from Linear
alone and adds an open question asking which repository the issue belongs in; it never asks the
"Which repository?" question ralph does.

The session is read-only, like a review: only `Read`, `Grep` and `Glob` inside the checkout, no
shell, no writes, no network, no project settings or hooks, and no Linear token (the agent returns
a typed result; the control panel makes every change in Linear). It sees the issue, its comments,
its sub-issues (with their states and priorities) and blockers.

### What it writes

The issue's title and description are rewritten as a PRD following the `linear-prd` methodology
(Introduction, Goals, Quality Gates, Non-Goals, Design and Technical Considerations, Success
Metrics) with a t-shirt size, then:

| Size | Result |
| -- | -- |
| XS, S, M | A single issue: the description carries the user story and its acceptance criteria. |
| L, XL | An epic: the description is the PRD without stories, and each story becomes a sub-issue (with priorities, sort order, its acceptance criteria, `manual` stories labelled with the repository's first **Manual label**, and "blocks" relations from the dependencies), plus a last `Validate functional requirements` sub-issue blocked by every other story. These go through the same materialization as a delegated PRD, so ralph builds the epic as `children` without rewriting it. |

An L/XL issue that already has sub-issues gets no new story sub-issues next to them; triage it
again to reformat them.

**Reformatting.** An issue that is already triaged but not in ralph's format (an epic with
sub-issues, or a PRD with the wrong sections) is reformatted in place:

- The parent's title and description are rewritten.
- Sub-issues in **Backlog** or **Todo** get their title, body and priority rewritten (only what
  changed) and missing "blocks" relations between siblings added; existing relations are kept.
- Sub-issues in any other state, and updates that don't name one of the issue's sub-issues, are
  ignored and listed in the response.
- An epic without a sub-issue whose title starts with "Validate" gets a `Validate functional
  requirements` sub-issue, ordered last and blocked by every sub-issue that isn't canceled.
- Triage never cancels, deletes, merges or re-parents sub-issues.

An issue already in the right format is left as it is (`unchanged`); only its open questions are
updated.

**The in-progress/done guard.** Before triage starts and again before it writes anything, the
control panel loads the issue and its sub-issues. If the issue or any sub-issue is in a `started`
(In Progress, In Review) or `completed` (Done) state, triage changes nothing in Linear and the
response names those issues. Canceled sub-issues don't count. Edit the PRD by hand, or move them
back to Backlog or Todo and triage again.

### Open questions and status

Every ambiguity triage can't resolve from the issue, its comments, its sub-issues and the source
becomes an open question instead of a guess. They go in a `## Open Questions` section at the very
end of the description, as a numbered list (never checkboxes, so ralph doesn't read them as
acceptance criteria). The section is left out when there are none and removed once all of them
are answered.

| Open questions | Status set |
| -- | -- |
| None | **Todo** (the team's first `unstarted` state): ready to delegate to ralph. |
| Some | **Backlog** (the first `backlog` state). The control panel also comments on the issue, @mentioning its creator, with the list. |

### Replying to continue

Reply in the triage session to answer the open questions (or add context): triage runs again
with your reply and its previous result, folds the answers into the PRD, drops the questions they
answer and sets the status again. A reply while triage is still running is queued and handled when
the current job ends. `stop` (or Linear's stop button) stops a running triage and cancels its job.
Editing the description yourself and triaging again works too.

### Ralph refuses issues with open questions

Ralph doesn't start a delegated issue, or a `/ralph` mention, while the issue's description (or,
for a sub-issue, its parent epic's) has a non-empty `## Open Questions` section: it answers in the
session that the questions need answering first, and materializes nothing and changes no state.
Answer them (a reply in the triage session, or by editing the description) and delegate again.
The same goes for `/ralph` switching a mention's run to the story loop (in a reply or a new
mention): the run stays in request mode until the questions are answered. Request-mode @mentions
and epic runs that are already going aren't affected.

## Agents and concurrency

Ralph jobs run on agents with the `ralph` capability ([deploy-harness.md](deploy-harness.md#ralph)).
An agent's **Concurrency per capability** caps how many of its slots ralph may take; by default
that's max concurrency − 1 (at least 1), so an agent with two or more slots keeps one free for
reviews while stories run. All jobs of a run (every lane) go to the run's sticky agent.
Triage jobs run on agents with the `triage` capability; like reviews, they may take every slot by
default, so lower its limit to keep slots free for other work. Agents under pm2 update themselves
to the version chosen on **Settings › Agents** ([deploy-harness.md](deploy-harness.md#self-update-pm2)).

## Troubleshooting

- **The session never acknowledges.** Check the webhook URL, that **Agent session events** is
  enabled, `LINEAR_WEBHOOK_SECRET` (a mismatch gives 401 in the function logs) and that the
  workspace is the connected one.
- **Runs don't resume after a blocker is done.** **Issues** webhook events are disabled. The
  `/api/cron/ralph-reconcile` cron (every 10 minutes) still catches up waiting runs.
- **Failed CI on a ralph PR/MR isn't picked up until the cron runs.** The GitHub App lacks
  **Actions: Read** or the `workflow_run` event, or the GitLab project webhook lacks **Pipeline
  events** (see [github-app.md](github-app.md), [gitlab.md](gitlab.md)).
- **Worktrees of merged ralph PRs/MRs stay on the agent host.** The cleanup runs on the run's
  sticky agent: if that agent is revoked or no longer has `ralph` enabled, nothing can reach its
  worktree (remove `<workspaceRoot>/.branches/...` by hand). Otherwise the cron retries a cleanup
  that failed every 10 minutes (the run's page shows why it failed).
- **"Which repository should I work in for this issue?" on every delegation.** Nothing routes the
  issue: add its label, project or team to a repository's routing, or tag the issue with
  `[repo=<path>]`.
- **"No repository has ralph enabled".** Enable ralph on a repository under
  **Repository › Settings › Ralph**.
- **Stories fail to push.** The code host credentials lack write access: see
  [github-app.md](github-app.md) and [gitlab.md](gitlab.md).
- **"I couldn't download … attachment(s) from Linear".** `HTTP 401`/`403` or an HTML page means
  Linear refused the connected workspace's token (reconnect it under **Settings › Integrations**);
  `larger than 25 MB` files aren't downloaded; `skipped: more than 20 attachments` ones are
  downloaded by the run's next job.
- **Triage never starts from the label.** The `ralph:triage` label doesn't exist in the workspace
  (or under another name), or **Issues** webhook events are disabled. A triage that can't start
  removes the label again; the session it opened says why.
- **"Triaging …" but nothing happens.** No agent has the `triage` capability enabled.
- **No agent picks the job up.** No agent has the `ralph` capability enabled, or the repository is
  pinned to an agent that doesn't ([deploy-harness.md](deploy-harness.md#ralph)).
