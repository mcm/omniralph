---
name: Omniralph control panel
description: Ultraviolet, the Omniralph 2.0 design system, for a dense console where people act on what needs them and follow every run, repo and agent.
---

# Design System: Omniralph control panel

The panel's visual system is **Ultraviolet**, shipped as `@omniralph/ui` (`packages/ui`). That
package is the authority for tokens, fonts, the Cursor glyph and every shared component; its
README lists them, and the canvas "Omniralph 2.0 — Primary Screens" (page "Ultraviolet —
final") is the source the tokens come from. This file doesn't repeat token values: it records
the Design rules, the user's decisions and how the panel applies the system. When the two
disagree, this file wins for `apps/web`. The agent's local UI follows this file too, with the
departures in `apps/agent/ui/DESIGN.md`.

Every critique round and fix story judges the UI against the Design rules and the Decided
items below. A finding that conflicts with either is rejected ("Rejected: rule N" or
"Rejected: decided — <item>"), never fixed or filed.

## Design rules

These apply to every screen, desktop and phone. When a screen breaks one, fix the screen.
Reports cite them as "rule N".

**Show, don't label**

1. **Every reference carries its icon.** A repo always shows its code host's mark (GitHub or GitLab) before its name. An issue shows its tracker's mark (Linear or Omniralph) before its ID. An organization shows a building icon. A size is a one-letter badge (S, M, L) with a tooltip. Any metadata shown on its own is a badge, never free text: organizations, issue identifiers, repo names and groups, branch names, MR/PR numbers, agents, versions, hosts, teams and labels, counts like "+2". The only exceptions are timestamps and durations (which sit in a fixed column) and metadata inside a sentence. Brand marks for every integration (GitHub, GitLab, Linear, Slack, Discord) come from @thesvg/react; Tabler stays for UI icons. Never show a bare name and expect the reader to guess what it is.
2. **Prefer icon > badge > text.** Use an icon when one is clear, a badge when a short label is needed, and text only when neither works. Don't show indicators that carry no information (every "Ready to start" item has a PRD, so "PRD" says nothing).
3. **No hint text about where things are** ("Finished work is in Runs"). If the layout needs it, the layout is wrong. Text that says what a setting does or what a change will cause stays.
4. **Human-readable activity.** Never show internal job names (`worktree.cleanup`); say what happened ("Cleaned up the SOC-1719 worktree"). The AI is called "Om" in copy; the machine is an "agent".

**Actions**

5. **Detail views put actions in a toolbar.** The one or two most likely actions are icon buttons with tooltips, grouped together with a ⋯ menu that holds everything else (open in Linear or GitLab, copy, remove…). Destructive items go last in the menu, after a divider, and ask to confirm.
6. **The exception is a needs-you decision.** When an item is waiting on you ("Done, resume epic", "Skip story", "Snooze"), those choices are labeled buttons, because the decision is the point of the screen. Only the button that clears the item is lavender.
7. **No keyboard shortcut indicators.** Shortcuts are supported, with one key per action across the whole app, and a Help page lists them.

**Lists and status**

8. **Lists stay short.** A list row shows its kind and state ("Request · failed"), a title and its references. Reasons, summaries and counts live in the detail; if I want to know why it failed, I'll open it.
9. **Show status only when something is abnormal.** No "Live" indicator; show a notice only when the page has stopped updating. No ambient stats lines (7-day totals belong on an analytics page, if we bring one back).
10. **Progress looks the same everywhere.** Any multi-step run uses the progress card from the Inbox: bar, a one-line count, and the steps. It's the default view of a run.
11. **Provenance behind an info button.** "Last changed by … when …, N runs since" sits behind an ⓘ next to the card title, in the same place on every card.
12. **Same kind of thing, same controls.** If one feature can be switched off (Coding), so can its peers (Reviews), with the same switch in the same place.

**Context**

13. **Organization first.** With "All organizations" selected, every detail header starts with the organization badge, before the kind or the issue, and every list row (Inbox, Runs, Backlog, Repos, Fleet) shows the organization badge ahead of its other badges. With a single organization selected, both disappear.
14. **Routing is visible where it matters.** A work item shows the repo it will route to. Testing where an issue would go lives with Routing rules in Settings, not on Repos.

**Color**

15. **Lavender/violet means needs you.** Mint means good (running, healthy). Coral means failed. Everything else is neutral.

**Phone**

16. **Phone screens carry less.** The phone shows the important information and a few actions; everything else goes behind a collapsed Details section or a ⋯ menu. Nothing is crammed into the first line. No keyboard hints. Bottom bar: Inbox · Runs · Backlog · Ask; Repos, Fleet and Settings in the menu.

**Settings controls**

17. **Summaries first, details on demand.** A setting backed by a profile (review Depth) shows a one-sentence plain-language summary, with an ID-card icon button that opens a popover listing the profile's technical details (model, token cap, what it reads).
18. **Lists of values are multi-inputs.** Paths, globs, labels and similar values are a token field (one removable chip per value, plus a field to add one), never a comma-separated string.
19. **Ordered or step-like content is a list.** Quality gates and other command sequences render as a numbered list, not as badges side by side.

**Building**

20. **Do it right the first time.** No interim versions, placeholders, stand-in links or temporary fallbacks between epics. If a screen needs another epic's work, it waits for it and builds the real thing.
21. **One reusable component per piece of functionality.** The same thing in two places is one component, built once and reused, never copied.
22. **The whole UI is live.** A user never refreshes. A change they make shows immediately, and backend changes (runs progressing, agents going offline, other people's actions) appear without a refresh. No "Live" indicator; show a notice only when live updates have stopped.
23. **"Show advanced settings" is a personal view setting.** It only shows or hides advanced settings for that user. It never changes what Omniralph does.
24. **Work items go through the tracker interface.** Anything that creates, updates, triages or cancels a work item uses it, never a tracker's API directly. The verb for turning an idea into a PRD is "Triage", and the button says "Triage now".

## Decided — never flag, never undo

The user reversed impeccable's earlier advice on these. No critique round flags them, and no
fix proposes, files or makes a change to one; only the user changes an item, by editing this
list. Each has a `decided:` row in `.impeccable/critique/ignore.md` with the same reason, which
suppresses critique and `impeccable detect` findings only, never an axe, keyboard, Escape or
landmark finding.

1. `detail-actions-toolbar` (rule 5): Detail actions are icon buttons with tooltips plus a ⋯ menu, even where impeccable advises otherwise. _Why:_ The user: "I genuinely don't care" if it goes against impeccable.
2. `metadata-is-a-badge` (rule 1): All standalone metadata (issue IDs, repos, branches, organizations, sizes, versions) is a badge. _Why:_ A badge with its icon says what kind of thing a value is at a glance, so nobody guesses at a bare name.
3. `icon-badge-text` (rule 2): Icon > badge > text; PRD and size are shown as badges or icons, never as words. _Why:_ Dense rows scan faster with icons and badges than with words.
4. `no-location-hints` (rule 3): No hint text about where things are, e.g. "Problems and running work have their own tabs". _Why:_ If the layout needs a hint, the layout is wrong.
5. `no-shortcut-indicators` (rule 7): No keyboard-shortcut indicators outside the Help page. _Why:_ Shortcuts are one key per action across the app, and the Help page lists every one.
6. `no-live-indicator` (rules 9 and 22): No "Live" or "Updated" indicator. _Why:_ The whole UI is live, so only a stop in live updates is worth a notice.
7. `no-row-status-summaries` (rules 8 and 9): No status summaries in list rows, and no stats lines on Inbox or Runs. _Why:_ Reasons, summaries and counts live in the detail, and status shows only when something is abnormal.
8. `light-phone-layout` (rule 16): The phone layout is deliberately light: fewer sections, details collapsed. _Why:_ A phone visit is a quick check or a decision, so the phone carries less.
9. `static-glyph`: The glyph is static: no animated or "live" logo. _Why:_ The logo decision keeps the Cursor still at every size.
10. `no-persona-framing`: No "Morning-after operator" or other persona framing in `PRODUCT.md`. _Why:_ The users are the organization's members, described by what they do, not by a persona.
11. `organization-badge-first` (rule 13): The organization badge comes first under "All organizations". _Why:_ Across organizations, which one an item belongs to is the first thing to know.
12. `mint-and-lavender` (rule 15): Mint means good or running; lavender is only for needs-you. _Why:_ Lavender stays rare so that it always means the screen needs you.

## Canvas boards

The canvas "Omniralph 2.0 — Primary Screens"
([https://claude.ai/artifact/6zfUafwddXxxXoGMJsYtZN](https://claude.ai/artifact/6zfUafwddXxxXoGMJsYtZN),
page "Ultraviolet — final") draws these boards; its `ui.css` is the visual reference for
`@omniralph/ui`. Each board maps to the routes that implement it, all captured by the
screenshot matrix (`scripts/screens/routes.ts`). Analytics (`/analytics`), Help (`/help`),
the signed-out pages and the agent's local UI have no board: they are held to the Design rules
and the `@omniralph/ui` components.

| Board         | Routes                                                                     | What it shows                                                |
| ------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Main          | `/`                                                                        | The Inbox with the full sidebar, dark                        |
| InboxUVL      | `/`                                                                        | The Inbox in the light theme                                 |
| InboxEmpty    | `/`                                                                        | The Inbox with nothing needing you                           |
| Runs          | `/runs`, `/runs/[id]`                                                      | The run list and a run's progress card, details and activity |
| Backlog       | `/backlog`, `/backlog/[id]`                                                | Work items and one open beside the list                      |
| Repos         | `/repos`, `/repos/[id]`                                                    | The repo list and a repo's settings cards with the save bar  |
| Fleet         | `/fleet`, `/fleet/[id]`                                                    | The agents and one agent's detail                            |
| Ask           | `/ask`, `/ask/new`, `/ask/[chatId]`                                        | Chats with Om                                                |
| Settings      | `/settings`, `/settings/general`, `/settings/members`, `/settings/profile` | The settings sheet and its sections                          |
| CursorAvatars | `/`, `/sign-in`                                                            | The Cursor glyph in the shell and on the signed-out card     |
| MobileInbox   | `/`                                                                        | The Inbox at 390 px: top bar and tab bar                     |
| MobileMenu    | `/`                                                                        | The phone menu (drawer) with Repos, Fleet and Settings       |
| MobileRun     | `/runs/[id]`, `/runs/[id]/steps/[stepId]`                                  | A run at 390 px, and a step as its own view                  |
| MobileAsk     | `/ask/[chatId]`                                                            | A chat at 390 px with the composer above the tab bar         |

## Widths and accessibility

- **1200 px and wider:** the full 232 px sidebar.
- **769–1199 px:** a 64 px icon rail; labels become tooltips and keep their accessible names.
- **768 px and narrower:** phone chrome: a top bar, the bottom tab bar (Inbox, Runs, Backlog,
  Ask) and the menu (Repos, Fleet, Settings). Nothing wraps under the navigation, and nothing
  widens the page.
- **WCAG 2.2 AA in both themes.** Dark is the default; light is a full theme, not an
  afterthought. Text and control-border contrast, keyboard operability, visible focus, named
  controls and target size hold in each.

## Overview

**Creative North Star: "The Flight Recorder"**

The panel is where people act on what needs them and look back at what Om and the agents did.
It should read like a well-kept instrument log: a calm dark page (or warm paper in light),
dense rows of exact facts (states, IDs, SHAs, timestamps, counts) in Geist Mono, and settings
that explain their consequences before they are saved. Lavender is rare on purpose: it means
the screen needs you.

**Key Characteristics:**

- The theme is the user's saved choice (System, Dark or Light, saved per user); System follows
  the OS as it changes, and dark is the fallback when nothing is known.
- Flat surfaces: page, side, surface and raised tones separated by hairlines, no ambient
  backdrop.
- Dense: tables and lists favor more rows per screen over padding, and become stacked cards on
  a phone.
- Every ID, SHA, branch, count, duration, token count and timestamp is set in mono.
- Screens compose `@omniralph/ui` components; `apps/web` adds domain views (run rows,
  transcripts) built from them, never copies of them.

## Colors

Only the `--or-*` tokens from `@omniralph/ui/styles.css` (dark on `:root` and
`[data-theme="dark"]`, light on `[data-theme="light"]`, applied to `<html>`). The panel adds no
colors of its own, and every documented text, accent and control-border pair meets WCAG AA in
both themes (enforced in `packages/ui`). A token value changes only to meet a WCAG
requirement, and keeps its hue and role.

### Named Rules

**The Meaning of Color Rule (rules 6 and 15).** Lavender/violet (`--or-acc`) means needs you,
mint (`--or-run`) means good or running, coral (`--or-fail`) means failed, and everything else
is neutral. Only the button that clears a needs-you item is `primary` (lavender, with the
glow); Save, Add and every other action are outline or solid neutral. A toast is never
lavender.

**The State Vocabulary Rule.** Every run, story, job, review and agent state maps to exactly one
tone, the same way everywhere (badge, dot, row tint). The map lives in one module (for runs,
`src/components/runs/run-status.ts`) and nothing chooses a state color locally. Charts carry no
state: their marks are neutral (`BarChart` in `@omniralph/ui`).

**The No Celebration Rule.** Routine actions (save, connect, retry, dismiss) are confirmed with
an inline "Saved" state or a toast, never an effect.

## Typography

Instrument Sans for the UI and headings (14 px base, line-height 1.4), Geist Mono for machine
facts, both self-hosted through `@omniralph/ui/fonts.css`.

**The Exact Values Rule.** Identifiers (Linear IDs, SHAs, job IDs, branch names), durations,
token counts, costs and timestamps are set in mono, and long ones truncate with the full value
available on hover and copy.

## Layout

- **The shell** (`components/app-shell.tsx`, `AppFrame` from `@omniralph/ui`) at the three
  widths above. The navigation lives in `src/lib/navigation.ts`; every entry points at a page
  that exists (`navigation.test.ts`). The organization picker and the user menu (theme, Sign
  out) are one component each, shown wherever the frame places them.
- **Dense data.** Lists and tables fill the content width. Detail pages put the key facts above
  the long content (progress log, attempts, findings).
- **Settings as forms with consequences.** Each setting has a label and a one-line description
  of what it affects (`Field`). Related settings are grouped in a card with one save bar. A
  destructive or run-affecting change asks to confirm and names what will change.
- **Phone screens carry less (rule 16).** At 390 px nothing widens the page: tables become
  stacked cards (`DataTable`) and long values truncate.

**The Classes, Not Pixels Rule.** Components set `className`; `style={{}}` with layout, spacing
or color values is a missing class or component. Inline styles are allowed only for genuinely
dynamic values (a progress segment's width, a chart size), each with a
`// dynamic-style: <reason>` comment. The design-system lint rules enforce this at `error`.

## Components

Everything comes from `@omniralph/ui`. The rules its components make the default:

- **References** carry their icon and standalone metadata is a badge (rules 1 and 2).
- **Detail actions** go in a `Toolbar` of icon buttons with tooltips plus a ⋯ menu;
  destructive items go last, after a divider, and ask to confirm (`ConfirmDialog`, rule 5).
- **Keys** appear only on the Help page (`/help`), which lists every shortcut in
  `src/lib/shortcuts.ts` (rule 7).
- **One progress view** (`ProgressCard`, rule 10). Provenance sits behind an ⓘ button next to a
  card's title (rule 11); details behind an ID-card button (rule 17); lists of values are token
  inputs (rule 18); ordered steps are numbered lists (rule 19).
- **Empty states** (`EmptyState`) say what will appear and how to make it happen.
- **Toasts** (`toast()` and the shell's `Toaster`): bottom right, above the tab bar on a phone,
  with a status dot in their tone and a dismiss button.
- **Live data (rule 22).** Every page reads its data in the browser from `/api/ui` through
  TanStack queries keyed with `queryKeys`, and the live data layer keeps it current without a
  reload (README, Data fetching). The shell's `LiveNotice` shows only when live updates have
  stopped; no screen adds its own polling or a "Live" indicator.
- **Navigation feedback.** A link whose page is loading dims and pulses after a short delay
  (`components/link.tsx`, passed to `UiProvider` as the link component).
- **Pending changes.** A save shows its pending state; switches change at once and roll back
  with a danger toast if the save fails; a change that takes effect on an agent's next
  heartbeat shows its in-between state and then its outcome.
- **Errors** say what failed, why if known, and what to do next, with a retry where one makes
  sense. An unexpected render error replaces the page inside the shell with Retry
  (`(app)/error.tsx`).
- **Copy.** "Om" for the AI, "agent", "work item", "run", "story", "repo", "Triage now";
  American English; never "Ralph" or "harness" in visible text.

## Do's and Don'ts

### Do:

- **Do** take tokens and components from `@omniralph/ui`, and add a shared component there when
  two screens need it (rule 21).
- **Do** keep lavender for what needs the user, mint for good, coral for failed.
- **Do** put IDs, SHAs, counts, durations and timestamps in mono.
- **Do** describe each setting's effect next to it, and confirm changes that affect runs.

### Don't:

- **Don't** add colors, hex or rgba literals, or inline layout styles in panel code.
- **Don't** show a control that does nothing yet, or a nav entry without a page (rule 20).
- **Don't** let a table or long ID widen the page at 390 px.
- **Don't** undo a Decided item.
