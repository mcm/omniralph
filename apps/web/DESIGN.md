---
name: Omniralph control panel
description: Ultraviolet, the Omniralph 2.0 design system, for a dense operator's console of runs, repositories, the fleet and settings.
---

# Design System: Omniralph control panel

The panel's visual system is **Ultraviolet**, shipped as `@omniralph/ui` (`packages/ui`). That
package is the authority for tokens, fonts, the Cursor glyph and every shared component; its
README lists them, and the canvas "Omniralph 2.0 — Primary Screens" (page "Ultraviolet —
final") is the source the tokens come from. This file doesn't repeat token values: it records
how the panel applies the system. When the two disagree, this file wins for `apps/web`.

**Coexistence until Epic 14.** The signed-in shell, the signed-out pages (sign-in, onboarding,
access denied, chat link, terms, privacy) and every toast are Ultraviolet. Today's screens under
`src/app/(app)` render inside the Ultraviolet shell but keep **Precision Aurora 1.1**
(`@iamthemcmaster/ui`) and the components only they use, until Epics 5–10 replace each one;
Epic 14 then removes the library. `src/legacy-ui-boundary.test.ts` keeps the library inside
those screens. No bridge tokens: a page is either Ultraviolet or Precision Aurora, never a mix.
New screens and components use `@omniralph/ui` only.

## Overview

**Creative North Star: "The Flight Recorder"**

The panel is where an unattended agent fleet is configured and audited after the fact. It
should read like a well-kept instrument log: a calm dark page (or warm paper in light), dense
rows of exact facts (states, IDs, SHAs, timestamps, counts) in Geist Mono, and settings that
explain their consequences before they are saved. Lavender is rare on purpose: it means the
screen needs you.

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
both themes (enforced in `packages/ui`).

### Named Rules

**The Meaning of Color Rule.** Lavender/violet (`--or-acc`) means needs you, mint (`--or-run`)
means good or running, coral (`--or-fail`) means failed, and everything else is neutral. Only
the button that clears a needs-you item is `primary` (lavender, with the glow); Save, Add and
every other action are outline or solid neutral. A toast is never lavender.

**The State Vocabulary Rule.** Every run, story, job, review and agent state maps to exactly one
tone, the same way everywhere (badge, dot, row tint, chart series). The map lives in one module
(on today's screens, `src/lib/state-variants.ts` with `ralph-badges.tsx` and
`review-badges.tsx`) and nothing chooses a state color locally.

**The No Celebration Rule.** Routine actions (save, connect, retry, dismiss) are confirmed with
an inline "Saved" state or a toast, never an effect.

## Typography

Instrument Sans for the UI and headings (14 px base, line-height 1.4), Geist Mono for machine
facts, both self-hosted through `@omniralph/ui/fonts.css`.

**The Exact Values Rule.** Identifiers (Linear IDs, SHAs, job IDs, branch names), durations,
token counts, costs and timestamps are set in mono, and long ones truncate with the full value
available on hover and copy.

## Layout

- **The shell** (`components/app-shell.tsx`, `AppFrame` from `@omniralph/ui`): a 232 px sidebar
  from 1200 px, a 64 px icon rail from 769 to 1199 px, and a top bar, bottom tab bar and drawer
  at 768 px and narrower. The navigation lives in `src/lib/navigation.ts`; every entry points at
  a page that exists (`navigation.test.ts`). The organization picker and the user menu (theme,
  Sign out) are one component each, shown wherever the frame places them.
- **Dense data.** Lists and tables fill the content width. Detail pages put the key facts above
  the long content (progress log, attempts, findings).
- **Settings as forms with consequences.** Each setting has a label and a one-line description
  of what it affects (`Field`). Related settings are grouped in a card with one save bar. A
  destructive or run-affecting change asks to confirm and names what will change.
- **Phone screens carry less.** At 390 px nothing widens the page: tables become stacked cards
  (`DataTable`) and long values truncate.

**The Classes, Not Pixels Rule.** Components set `className`; `style={{}}` with layout, spacing
or color values is a missing class or component. Inline styles are allowed only for genuinely
dynamic values (a progress segment's width, a chart size), each with a
`// dynamic-style: <reason>` comment. The design-system ESLint rules enforce this at `error`.

## Components

Everything comes from `@omniralph/ui`. The rules its components make the default:

- **Every reference carries its icon**: repository = code-host mark + name, issue = tracker
  mark + ID, organization = building icon. Icon beats badge beats text.
- **Detail actions** go in a `Toolbar` of icon buttons with tooltips plus a ⋯ menu;
  destructive items go last, after a divider, and ask to confirm (`ConfirmDialog`).
- **No keyboard-shortcut hints** anywhere, and no hint text about where things are.
- **One progress view** (`ProgressCard`: bar, one-line count, steps). Provenance sits behind an
  ⓘ button next to a card's title; details behind an ID-card button; lists of values are token
  inputs; ordered steps are numbered lists.
- **Empty states** (`EmptyState`) say what will appear and how to make it happen.
- **Toasts** (`toast()` and the shell's `Toaster`): bottom right, above the tab bar on a phone,
  with a status dot in their tone and a dismiss button.
- **Live data.** Every page reads its data in the browser from `/api/ui` through TanStack
  queries keyed with `queryKeys` and keeps it current without a reload (README, Data fetching).
- **Navigation feedback.** A link whose page is loading dims and pulses after a short delay
  (`components/link.tsx`, passed to `UiProvider` as the link component).
- **Pending changes.** A save shows its pending state; switches change at once and roll back
  with a danger toast if the save fails; a change that takes effect on an agent's next
  heartbeat shows its in-between state and then its outcome.
- **Errors** say what failed, why if known, and what to do next, with a retry where one makes
  sense. An unexpected render error replaces the page inside the shell with Retry
  (`(app)/error.tsx`).
- **Copy.** The AI is "Om" and the machines are agents in all new copy; American English.

## Do's and Don'ts

### Do:

- **Do** take tokens and components from `@omniralph/ui`, and add a shared component there when
  two screens need it.
- **Do** keep lavender for what needs the user, mint for good, coral for failed.
- **Do** put IDs, SHAs, counts, durations and timestamps in mono.
- **Do** describe each setting's effect next to it, and confirm changes that affect runs.

### Don't:

- **Don't** import `@iamthemcmaster/ui` outside today's screens (the boundary test fails).
- **Don't** add colors, hex or rgba literals, or inline layout styles in panel code.
- **Don't** show a control that does nothing yet, or a nav entry without a page.
- **Don't** let a table or long ID widen the page at 390 px.
