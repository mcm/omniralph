---
name: Omniralph control panel
description: Precision Aurora 1.1, tuned for a dense operator's console of settings, runs and history.
---

# Design System: Omniralph control panel

The panel's visual system is **Precision Aurora 1.1** (`@iamthemcmaster/ui`). Its `DESIGN.md`
(in the `thefrakinship/mcmaster-ui` repository, and summarised in the package README) is the
authority for tokens, typography, shapes, components and motion. This file doesn't repeat
those tokens: it records only how the panel applies the system and where it deliberately
departs from it. When the two disagree, this file wins for `apps/web`.

## Overview

**Creative North Star: "The Flight Recorder"**

The panel is where an unattended agent fleet is configured and audited after the fact. It
should read like a well-kept instrument log: calm Polar Night, dense rows of exact facts
(states, IDs, SHAs, timestamps, counts) in mono metrics, and settings that explain their
consequences before they are saved. Precision Aurora's calm is kept; its showcase moments are
mostly left out, because almost nothing here is a forward action to celebrate.

**Key Characteristics:**
- The theme is the user's saved choice, else the OS preference; Polar Night when neither is
  known, as in the library.
- Data surfaces (run, review and job lists and details, analytics, settings) turn the ambient
  field off. Only the sign-in, onboarding and legal shells keep `AuroraField`.
- Denser than the library's defaults: tables and lists favour more rows per screen over padding.
- Every ID, SHA, count, duration and timestamp uses mono metrics.
- Screens are built from `PageHeader`, `Stack`, `Cluster`, `Grid` and `Metric`, not inline styles.

## Colors

The panel uses the library's semantic roles only (`--bg-*`, `--text-*`, `--border-*`,
`--accent*`, `--{status}*`). It adds no colors of its own.

### Named Rules

**The State Vocabulary Rule.** Every run, story, job, review and harness state maps to exactly
one of the library's variants, the same way everywhere (badge, dot, row tint, chart series):
`success` for completed or passed; `warning` for blocked, waiting or needing a person; `danger`
for failed or exhausted; `info` for running or in progress; `neutral` for pending, cancelled or
skipped. The map lives in one module (today `ralph-badges.tsx` and `review-badges.tsx`) and
nothing chooses a state color locally.

**The No Celebration Rule.** The aurora button and the achievement sweep are not used for
routine panel actions (save, connect, retry, dismiss). Saving a setting is confirmed with a
toast and an inline "Saved" state, not the ribbon.

## Typography

As in Precision Aurora 1.1: the UI tier for component text, the reading tier for page titles
and prose, with an 11px floor.

**The Exact Values Rule.** Identifiers (Linear IDs, SHAs, job IDs, branch names), durations,
token counts, costs and timestamps are set in mono metrics (`.text-numeric` or `numeric` table
cells), and long ones truncate in the middle with the full value available on hover and copy.

## Layout

The library's spacing steps and primitives, with two panel-specific choices:

- **Dense data.** Lists and tables use compact rows and fill the content width. Detail pages put
  the key facts (state, repository, branch, timing, attempts) in a `Grid` of `Metric`s or a
  definition list above the long content (progress log, attempts, findings).
- **Settings as forms with consequences.** Each setting has a label, a one-line description of
  what it affects, and its default, wired through `Field`. Related settings are grouped in cards
  with one save action per card. A destructive or run-affecting change asks for confirmation and
  names what will change.
- At 390px nothing widens the page: wide tables scroll inside their own container, and the
  sidebar becomes the library's built-in mobile sheet.

**The Primitives, Not Pixels Rule.** Inherited from the library: `style={{}}` with layout,
spacing or color values is a missing primitive. Inline styles are allowed only for genuinely
dynamic values (a computed width or a chart size), each with a comment.

## Elevation & Depth

As in Precision Aurora 1.1 (tone first, faint shadows, strata on raised wells), with the
ambient field off on data surfaces so tables and cards sit on a flat page.

## Components

Everything comes from `@iamthemcmaster/ui`. Panel-specific components (`app-shell`,
`app-sidebar`, `list-pagination`, the badge maps) compose library primitives and follow the
same rules: rime focus, the library's states in both themes, and no local colors.

- **Empty states** use the library's `Empty` (frozen ribbon) with a sentence that says what will
  appear here and how to make it happen (e.g. "Delegate a Linear epic to the Omniralph app to
  start a run").
- **Live data.** Every page reads its data in the browser from the panel's `/api/ui` endpoints
  and keeps it current: it refetches every 3 seconds while the tab is visible and as soon as the
  tab is back (README, Data fetching). A page never asks for a reload to show a change.
  Pages of in-flight entities show how fresh they are in the header (`Freshness`, "Updated 3s
  ago"), which turns into a warning with a retry when refetching has failed for 30 seconds.
  Relative times tick on the browser's clock.
- **Loading** uses the whiteout `Skeleton` shaped like the content it replaces, shown at once on
  navigation. A list moving to another page or filter keeps the previous rows, dimmed
  (`aria-busy`), while the new ones load.
- **Navigation feedback.** A link whose page is loading (sidebar items, breadcrumbs, tabs, row
  links, pagination) dims and pulses after a short delay, so fast navigations don't flicker
  (`components/link.tsx`).
- **Pending changes.** A save shows its pending state ("Saving…", disabled fieldset); switches
  and toggles change at once and roll back with a danger toast if the save fails; a change that
  takes effect on a harness's next heartbeat shows its in-between state ("Saved — waiting for
  …", "Cancel requested") and then its outcome.
- **Errors** say what failed, why if known, and what to do next, with a retry where one makes
  sense. A failed load is shown in place of the content it was loading, with Retry; an
  unexpected render error replaces the page (sidebar and header stay) with Retry
  (`(app)/error.tsx`).

## Do's and Don'ts

### Do:
- **Do** use the one state-to-variant map for every run, story, job, review and harness state.
- **Do** put IDs, SHAs, counts, durations and timestamps in mono metrics.
- **Do** describe each setting's effect and default next to it, and confirm changes that affect
  runs.
- **Do** keep the ambient field off on data surfaces.
- **Do** build screens from the library's layout primitives.

### Don't:
- **Don't** use the aurora button or achievement sweep for routine panel actions.
- **Don't** add colors, hex or rgba literals, or inline layout styles in panel code.
- **Don't** let a table or long ID widen the page at 390px.
- **Don't** depart from the library's look except for the density and ambient choices recorded
  here.
