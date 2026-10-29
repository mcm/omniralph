# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The members of an organization that runs Omniralph for its repos. They open the control panel
to act on what needs them: a story an agent can't finish, a review waiting on a decision, a
triaged work item to start, an agent gone offline. Then they leave. Admins also change setup
(repos, connections, members, defaults). Most visits are at a desk; some are a quick check
from a phone.

## Product Purpose

Omniralph runs unattended coding agents for GitHub and GitLab. Om, the AI, builds epics story
by story, reviews pull and merge requests, triages ideas into PRDs, and answers in Ask. The
agents are the machines Om works on. The control panel is where people see what needs them,
follow every run, and set up the repos, the fleet and the organization.

Success: a member opens the Inbox, clears what needs them in a few decisions, and trusts that
nothing else does. Every run explains what happened without a database query, and settings
can be changed without breaking a repo's runs.

## Positioning

The one place where people and Om meet: the Inbox says what needs a person, and every other
screen shows what Om and the agents did, are doing and will do next.

## Operating Context

- Organizations own everything. Roles are `admin` (changes setup) and `member` (sees
  everything and acts on Inbox items). A user in two or more organizations can pick "All
  organizations".
- Screens (`src/lib/navigation.ts`):
  - **Inbox** (`/`): what needs you, one decision per item.
  - **Runs**: every coding, review and triage run, with its progress, steps and activity.
  - **Backlog**: the work items in the tracker, ready to triage or start ("Triage now").
  - **Repos**: each repo's coding, review and agent settings, and its rules.
  - **Fleet**: the agents, their health, version and packages; enroll, update or revoke.
  - **Ask**: chat with Om about the organization's repos and runs.
  - **Settings**: the organization, members, connections, your profile and theme, and
    advanced settings.
  - **Analytics**: how well runs and reviews are going over time.
  - **Help**: the keyboard shortcuts.
- **The agent's local UI** (`apps/agent/ui`), served by each agent on 127.0.0.1, holds that
  machine's own settings: capacity, packages, host tools, version, the Claude sign-in and
  storage, plus its overview and logs.
- Runs are long and asynchronous, and the whole UI is live: runs progressing, agents going
  offline and other people's actions appear without a refresh.

## Capabilities and Constraints

- Next.js app router hosting a client-rendered panel. Each `page.tsx` renders a client view
  that reads and writes through the panel's own JSON API (`/api/ui/*`) with TanStack Query.
  Change events invalidate exactly the queries they affect, and polling runs only while the
  realtime connection is down (README, Data fetching).
- All UI is built from `@omniralph/ui` (`packages/ui`), the Ultraviolet design system, with
  `@tabler/icons-react` for UI icons and `@thesvg/react` for brand marks (`DESIGN.md`).
- Vocabulary: **Om** (the AI), **agent** (a machine Om runs on), **work item** (an issue in
  the tracker), **run** (one coding, review or triage job), **story** (one step of an epic's
  run), **repo**, **organization**, **finding**, **rule**, and **Triage now** for turning an
  idea into a PRD. American English.
- Work items are created, updated, triaged and cancelled through the tracker interface only.
- Settings are dense and interdependent; a mistake can silently break later runs.

## Brand Commitments

Ultraviolet, as `@omniralph/ui` defines it: its tokens, fonts and the Cursor glyph. Lavender is
rare on purpose: it means the screen needs you.

## Evidence on Hand

Real data comes from a live database; screenshots use the fixture seed
(`apps/web/scripts/fixtures`). Do not invent metrics, customers or outcomes in UI copy.

## Product Principles

1. **Needs you, or nothing.** The Inbox shows only what needs a person, and every screen shows
   status only when it is abnormal.
2. **Configuration is safe by default.** Every setting says what it affects before it is saved.
3. **History answers questions.** Runs and analytics answer "what happened, why, and is it
   getting better", in human-readable activity.
4. **Density over decoration.** Information density and scanability beat whitespace.
5. **Desktop-first, phone-capable.** Every screen works at 390 px; the phone carries less.

## Accessibility & Inclusion

WCAG 2.2 AA in both themes (dark is the default; light is a full theme): text and control
contrast, keyboard operability, visible focus, named controls and target size.
