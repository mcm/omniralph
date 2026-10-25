# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primarily the owner: one person who runs Omniralph for their own repositories (sometimes a few
teammates in the same organization). They open the panel to check on ralph runs, reviews and
jobs, to work out why something stalled, and to change repository, ralph, review or harness
settings. Most day-to-day interaction with Omniralph happens in Linear and Slack/Discord; the
panel is where they come to configure it and to look back at what happened.

## Product Purpose

The control panel for Omniralph, a self-hosted system that runs unattended coding agents for
GitHub and GitLab: ralph builds Linear epics story by story, reviews PRs/MRs, triages issues into
PRDs, and answers in chat. The panel connects code hosts, Linear and chat; enrolls and configures
harnesses; holds per-repository settings, review profiles and learned rules; and records every
run, review, job and outcome.

Success: settings can be changed confidently without breaking a repository's runs, and the history
of runs, reviews and outcomes answers "what happened and how well is it working" without a database
query.

## Positioning

It is the single place where an unattended agent fleet is configured and audited. The agents work
elsewhere (Linear, code hosts, chat); the panel is where their behaviour is set and where their
record lives.

## Operating Context

- Organizations own everything; roles are `admin` (changes setup) and `member` (sees everything,
  can dismiss/restore findings). Sign-in is next-auth, gated by allowed email domains and
  invitations.
- Main areas (see `src/lib/navigation.ts`): Ralph runs, Reviews, Jobs, Analytics, Repositories
  (and per-repository settings, rules and reviews), Harnesses, and Settings (organization,
  integrations, chat accounts, profiles, harnesses).
- Runs are long-lived and asynchronous; most visits happen after the fact, but every page stays
  live while open: harnesses, webhooks and crons change runs, reviews, jobs and harnesses
  behind the user's back, and the page shows it within seconds.
- Used mostly at a desk; occasionally checked from a phone.

## Capabilities and Constraints

- Next.js 16 app router hosting a client-rendered panel: each `page.tsx` under `(app)` renders a
  client view that reads and writes through the panel's own JSON API (`/api/ui/*` route
  handlers) with TanStack Query, polling every 3s while the tab is visible (settings 30s, analytics 60s) and on focus; every
  change invalidates the views it affects. Only the signed-in layout runs on the server (the
  session gate). No server actions, and no page reads the database (README, Data fetching).
- All UI uses `@iamthemcmaster/ui` (Precision Aurora), `@tabler/icons-react` and `sonner`. No
  other component or styling library. Custom styling uses the library's design tokens only.
- Terminology to keep: organization, repository, harness, ralph run, story, lane, review run,
  finding, learned rule, profile, job, triage, follow-up, manual story.
- Settings are dense and interdependent (verify commands, quality gates, task
  choices, caps); mistakes silently break later runs.

## Brand Commitments

Stay close to the Precision Aurora design system (`@iamthemcmaster/ui`), but deviating is fine
where it clearly benefits this product (for example, denser data views than the library's
defaults).

## Evidence on Hand

Real data only comes from a live database; there is no seed dataset or screenshot fixture yet.
Do not invent metrics, customers or outcomes in UI copy.

## Product Principles

1. **Configuration is safe by default.** Every setting says what it does, what it affects, and
   what happens if it is wrong, before it is saved.
2. **History answers questions.** Runs, reviews and analytics are organised around "what happened,
   why, and is it getting better", not around database tables.
3. **Density over decoration.** This is an operator's tool: information density and scanability
   beat whitespace and marketing polish.
4. **Desktop-first, phone-capable.** Designed for a desk; a run or review can still be checked at
   390px without horizontal scrolling.

## Accessibility & Inclusion

WCAG 2.2 AA: text and UI-boundary contrast in every theme, keyboard operability, visible focus,
and named controls.
