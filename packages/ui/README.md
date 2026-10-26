# @omniralph/ui

The Ultraviolet design system: tokens, fonts, the theme runtime and the shared components
used by `apps/web` and the agent's local UI. It runs in plain React: it imports nothing from
`next` or `@iamthemcmaster/*` (enforced by lint and a test), so routing comes in through
props and context.

## Styles

Import the two stylesheets once, at the root of the app, fonts first:

```ts
import "@omniralph/ui/fonts.css"; // Instrument Sans and Geist Mono, self-hosted (woff2)
import "@omniralph/ui/styles.css"; // tokens and every component stylesheet
```

In `apps/web` they go in `src/app/layout.tsx`, after the `@iamthemcmaster/ui` styles and
before `globals.css`. The CSS ships as authored (no build step).

Tokens are CSS custom properties with the `--or-` prefix (`--or-page`, `--or-text`,
`--or-acc`, `--or-radius`, `--or-side-w` …), and classes use `or-`. Dark is the default
(`:root` and `[data-theme="dark"]`); `[data-theme="light"]` on `<html>` switches to light.

## Providers

Wrap the app in `UiProvider` and `ThemeProvider`:

```tsx
import { ThemeProvider, UiProvider, type ThemePreference } from "@omniralph/ui";
import { Link } from "@/components/link"; // the app's router link
import { saveThemePreference } from "@/lib/theme-actions"; // persists the choice

export function Providers({
  theme,
  children,
}: {
  theme: ThemePreference;
  children: React.ReactNode;
}) {
  return (
    <UiProvider linkComponent={Link}>
      <ThemeProvider
        preference={theme}
        onPreferenceChange={async (next) => {
          const result = await saveThemePreference(next);
          if (!result.ok) throw new Error(result.error); // restores the previous theme
        }}
      >
        {children}
      </ThemeProvider>
    </UiProvider>
  );
}
```

- `UiProvider` takes `linkComponent`, which renders every link the components draw. It
  receives an anchor's props with a required `href`; without it a plain `<a>` is used.
  Components read it with `useLinkComponent()`.
- Components that show an active location (the shell's nav) take the current path as a
  `currentPath` prop: pass your router's path (`usePathname()` in Next.js,
  `location.pathname` elsewhere).
- `ThemeProvider` takes the saved `preference` (`"system" | "dark" | "light"`) and calls
  `onPreferenceChange(preference)` once each time it changes; persisting it is the app's job.
  The new theme applies at once; if `onPreferenceChange` returns a promise that rejects, the
  previous preference comes back (unless a newer choice was made meanwhile). It sets `data-theme` on `document.documentElement` and, on `system`, follows
  `prefers-color-scheme` as the OS changes (dark when the OS states no preference).
  `useTheme()` returns `{ preference, resolved, setPreference }`, and `resolveTheme(preference,
prefersLight)` is the pure rule behind it.
- `ThemeControl` is the one theme control (a user menu, settings, the agent UI): a "Theme"
  `SegmentedControl` with System, Dark and Light (`THEME_OPTIONS`) bound to `useTheme()`.
  `size` defaults to `sm`. To avoid a flash before hydration, set
  `data-theme` with an inline script before paint (`THEME_BOOTSTRAP` in `apps/web`).

## Actions

Detail actions follow Design rules 5–7: up to two icon buttons plus a ⋯ menu, labeled
buttons only for decisions, and no keyboard-shortcut hints anywhere.

- `Button`: `variant` `outline` (default), `solid`, `primary`, `ghost` or `danger`; `size`
  `md` (36 px) or `sm` (30 px); optional leading Tabler `icon`. A native
  `<button type="button">`, or a link through `UiProvider` when `href` is given. `primary`
  (lavender with the glow) is only for the action that clears a needs-you item.
- `TextLink`: an inline text link (`or-link`, underlined) rendered through `UiProvider`'s
  link component, e.g. a run's title inside a sentence.
- `IconButton`: a required `label` is its accessible name and its tooltip.
- `Tooltip`: Radix tooltip shown on hover and keyboard focus; carries its own provider.
- `Toolbar`: `label`, up to two `actions` in one bordered group, and `menu` items behind a
  ⋯ "More actions" button. One tab stop; Left/Right/Home/End move between its buttons.
- `Menu`: `items` (`{ label, icon?, onSelect | href, destructive?, disabled?, checked? }`
  or `"separator"`) opened from `trigger`. Destructive items always render last, after a
  separator, in coral; their `onSelect` should open a `ConfirmDialog`. An item with
  `checked` is a `menuitemcheckbox` choice with a check after its label when `true` (e.g.
  the current organization). `header` renders content above the items (e.g. who is
  signed in and a `ThemeControl`, styled with `.or-menu__heading`, `-title` and `-detail`);
  its controls keep their own keys, and Tab / Shift+Tab move between them and the items.
  Consecutive items with the same `group` form a labeled `role="group"`; `mark` (a node,
  e.g. a `BrandMark`) replaces the icon; `keepOpen` items don't close the menu.
- `FilterMenu`: `label`, `options` (`{ value, label, icon?, group? }`; `icon` is a Tabler
  icon or a mark element), `selected`, `onChange` and `multiple?`. The `.or-filter` button
  is named "{label}: All" or "{label}: " and the chosen labels (more than two shorten to
  "A, B +n" on screen); its `Menu` has "All", a checkable item per option (grouped by
  `group`), and with `multiple` toggles that keep the menu open plus a "Clear" item.
- `ConfirmDialog`: controlled (`open`, `onOpenChange`) `role="alertdialog"` with `title`,
  `description`, `confirmLabel`, `destructive?` and `typedConfirmation?` (confirm stays
  disabled until it is typed exactly). `onConfirm` runs once, then the dialog closes.

## Controls

Keyboard-operable form controls (Design rule 12). Each shows the accent focus ring on
`:focus-visible`.

- `Switch`: an on/off setting, `<button role="switch" aria-checked>`. Named by a visible
  `label` or by `aria-label` / `aria-labelledby`; `checked` + `onCheckedChange` (or
  `defaultChecked`), `disabled`. Click, Space and Enter toggle it.
- `Checkbox`: a native `<input type="checkbox">` inside its `<label>` (or with `aria-label`),
  drawn with the custom appearance. `checked`, `defaultChecked`, `indeterminate` (sets the
  DOM property), `disabled`, `onCheckedChange`.
- `RadioList`: one-of-N `options` (`{ value, label, disabled? }`; a label can be a reference
  badge) as a vertical Radix radio group under a visible `label` that names it (`aside`
  shows beside the label, outside the name); `value` +
  `onValueChange` (or `defaultValue`), `disabled`, `name`. One tab stop; Up and Down move
  and select (wrapping). `mono` draws the option labels in the mono face.
- `SegmentedControl`: one-of-N `options` (`{ value, label, icon?, disabled? }`) as a
  `radiogroup` with one tab stop; `value` + `onValueChange` (or `defaultValue`), `size`
  `md` / `sm`. Arrow keys move and select, Home/End select the first and last option.
- `Tabs`: Radix tabs from `tabs` (`{ value, label, count?, countTone?, disabled? }`), with
  `TabPanel value` children for the panels. `countTone` `need` draws the count in the
  accent and `fail` in coral; the count is part of the tab's name ("Needs you, 4"). Arrow
  keys move and select, Home/End jump; the strip scrolls sideways instead of wrapping.

## Fields

Text fields on `--or-page` with the `--or-ctl` border; hover lifts the border, focus draws
it in the accent with the halo.

- `Field`: a setting row with `label` (a `<label for>` the control), an optional one-line
  `description` (linked to the control by `aria-describedby`) and one control as children,
  in a 200 px + flexible grid that collapses to one column at 768 px and narrower
  (`stacked` keeps it one column at every width, for narrow cards). The control picks its
  id up from the Field (or pass `htmlFor`).
- `TextInput`, `Textarea`, `Select` (a styled native `<select>` with `<option>` children):
  `invalid` sets `aria-invalid`; `errorMessage` renders under the control, linked by
  `aria-describedby` (and implies `invalid`); `mono` sets Geist Mono.
- `TokenInput`: a list of values edited one chip at a time (Design rule 18). `values`,
  `onChange`, `placeholder`, `validate(value) => string | null`, `mono` (default true).
  Enter or comma adds the trimmed text; empty and duplicate values are skipped; pasted
  lines or comma-separated text add one token per part; Backspace in the empty input
  removes the last token; each chip has a "Remove <value>" button. A `validate` error is
  shown under the box, linked by `aria-describedby`, and blocks the add. Focus stays in the
  text input.

## Brand

- `Glyph`: the Cursor mark without a tile, `size` px (default 24). The ring takes
  `currentColor` and the cursor `--or-acc`. Sizes up to 32 px use the small master
  (`CURSOR_SMALL`), larger ones the large master (`CURSOR_LARGE`). Decorative
  (`aria-hidden`) unless given a `label`, which makes it `role="img"`.
- `Wordmark`: lowercase "omniralph", 17 px, weight 600.
- `BrandLockup`: the 24 px glyph and the wordmark on one baseline. With `href` it is a link
  named "Omniralph home", rendered through the `UiProvider` link component.
- `tileSvg({ size, master, shape })`: tile A (violet `#6236D6`, white mark) as an SVG
  string, `rounded` (rx 5.5) or full-bleed `square`. Never theme-swapped.

`pnpm --filter @omniralph/ui brand-assets` regenerates the favicon set in
`apps/web/public` (`favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`) with `sharp`;
commit the outputs. `src/brand/assets.test.ts` fails when they drift from `tileSvg`.

## References

Every reference carries its icon (Design rules 1, 2). Badges are a plain `<span>` unless
given `href`, which renders them through the `UiProvider` link component. Long text is
truncated with an ellipsis and keeps the full text in `title`.

- `BrandMark` (`brand`: `github` | `gitlab` | `linear` | `slack` | `discord`, `size`
  default 14): the `@thesvg/react` mark, imported by deep path (`@thesvg/react/github`,
  never the index), `variant="mono"` so it takes `currentColor`. `role="img"`, named
  "GitHub", "GitLab", "Linear", "Slack" or "Discord". Slack has no mono variant upstream,
  so `refs.css` paints its default mark in `currentColor`.
- `OrgBadge` (building icon + name, `title="Organization"`), `RepoBadge` (`host` mark +
  name, optional `strong`), `IssueBadge` (`tracker`: `linear` mark or the 15 px `Glyph`
  for `omniralph`, + mono ID), `BranchBadge` (branch icon + mono name), `ChangeBadge`
  (merge icon + `!<n>` for GitLab, `#<n>` for GitHub), `AgentBadge` (server icon + name),
  `MetaBadge` (optional decorative Tabler icon + text, optional `mono`). Icons that carry
  meaning are `role="img"` named after the kind ("Organization", "Branch", "Merge
  request", "Pull request", "Agent"), so a badge reads e.g. "GitLab acme/api".
- `SizeBadge` (`XS` | `S` | `M` | `L` | `XL`, `T_SHIRT_SIZES`): the mono letters, named and
  tooltipped "Size S", "Size XL" etc.
- `RefBadge`: the shared badge shape, for screen epics that need another kind.

## Status

`StatusTone` is `need` (accent with the halo), `run` (mint with the run glow), `good`
(mint), `fail` (coral) or `neutral` (`--or-done` dot, `--or-sec` text) (Design rule 15).

- `StatusDot` (`tone`, required `label`): the dot alone, `role="img"` named by `label`.
- `StatusText` (`tone`, children): a decorative dot followed by the label, in the tone's
  color.
- `StatusLine` (`tone`, children, optional `dotLabel`): the line under a detail header
  ("Waiting on you for 15 days"). A `role="status"` paragraph named by its sentence, a
  `StatusDot` (named `dotLabel`, else the tone's `STATUS_LINE_DOT_LABELS` entry) and the
  sentence, in the tone's color.

Component CSS uses only `--or-` tokens: a test fails on any color literal outside
`tokens.css`.

## Feedback

- `toast(message, { variant?, duration? })`: shows a toast from anywhere (hooks, plain
  callbacks, code that runs before a `Toaster` mounts: the toast waits in a module-level
  store). `variant` is `success` (default, mint dot), `info` or `warning` (neutral dot) or
  `danger` (coral dot). Returns an id for `dismissToast(id)`; `clearToasts()` empties the
  queue (e.g. between tests).
- `Toaster` (`label`, default "Notifications"): mount once per page tree. A named region,
  bottom-right on desktop and above the tab bar at 768 px and narrower. Success, info and
  warning messages are `role="status"`, danger is `role="alert"`; each toast has a
  "Dismiss" button. Success, info and warning leave after 5 s and danger after 8 s
  (`TOAST_DURATIONS`), paused while the toast is hovered or focused; at most 3 show
  (`MAX_TOASTS`), the oldest leaving first. No accent: a toast never means "needs you".
- `LiveNotice` (`onRetry`): the one connection status an app shows (Design rule 9). A
  `role="status"` strip saying "Live updates stopped. Retrying…" (`LIVE_NOTICE_MESSAGE`) with a
  neutral dot and a "Retry now" button. Render it above the page content only once live updates
  have been down for a while (the web shell waits 5 s); there is no "connected" counterpart.

## Surfaces

- `Card`: a `section` labeled by its `title` (`headingLevel` 2–4, default 2), with
  optional `info` (provenance behind an ⓘ `InfoPopover` right after the title, Design
  rule 11; `infoLabel` defaults to "About this card"), optional right-aligned `actions`
  and children.
- `ProgressCard`: the one progress view (rule 10). `title`, optional `titleHref`,
  `actions` (right of the title, e.g. an "Open run" link), `summarySuffix` (appended to the
  count line, e.g. a total duration) and `steps` (`{ id, label, state, meta?, href? }`,
  `state` `done` | `waiting` | `running` | `failed` | `blocked` | `pending` | `canceled`).
  One bar segment per step (done `--or-sec`, waiting `--or-acc`, running `--or-run`, failed
  `--or-fail`, others `--or-border`), a one-line count, and the steps as a numbered `<ol>`
  (a canceled step shows a dash icon instead of a dot). The bar is a `progressbar`
  (`aria-valuenow` done steps, `aria-valuemax` total, `aria-valuetext` the count line).
  With `onSelectStep(id)` the steps are buttons (step `href`s are ignored) and the
  `selectedStepId` one is bold with `aria-current="step"`.
- `progressSummary(steps, suffix?)`: the count line, e.g. "8 of 9 done · 1 canceled · 3h
  31m": the done count, then waiting, running, failed, blocked and canceled when non-zero,
  then the suffix, or "No steps yet".
- `SaveBar`: `changes` (`{ id, label, from?, to?, effect? }`), `onSave`, `onDiscard`,
  `saving?`, `error?`. Renders nothing without changes; otherwise a sticky `region` named
  "Unsaved changes" listing each change (label, from → to, effect sentence), a ghost
  Discard and a solid Save (never `primary`, rule 6). Both are disabled while `saving`;
  `error` shows in an `alert`.
- `InfoPopover` (ⓘ, `label` default "About this card", children) and `DetailsPopover`
  (ID card, `label` default "Details", `items: { term, detail }[]` as a `<dl>`, rule 17):
  icon buttons that open a Radix popover named by the label. Click, Enter and Space open
  it; Escape closes it and returns focus to the button.
- `DetailsSection`: a native `<details>` (collapsed) with a chevron `<summary>`, `title`
  default "Details".
- `EmptyState`: `title` heading, optional one-sentence `description`, optional `action`
  and decorative `icon`. There is no hint prop (rule 3).

## Lists

- `DataTable<T>`: `rows`, `getRowId`, `columns` (`{ id, header, cell(row), card?, align?,
mono? }`), a required `caption` (visually hidden), and optional `getRowHref`,
  `selectedId` and `rowTone(row)`. It renders a real `<table>` (`<caption>`,
  `<th scope="col">`) in `.or-tblwrap` above 768 px and the same rows as a `<ul>` of
  stacked cards (`.or-cards`) at 768 px and narrower (Design rule 16). `card` places a
  column on the phone card: `status` and `time` on the top line, the `title` (the first
  column when none is marked), then `meta` (the default) badges; `hidden` columns are
  left out. With `getRowHref`, the title cell and the card title hold the row's one link
  (through the `UiProvider` link component), stretched over the row, so a click anywhere
  follows it. Keep links out of the title cell; buttons and checkboxes in other cells stay
  siblings of the link and above it. `selectedId` marks the row and card with
  `aria-current="true"` (`--or-sel`); `rowTone` `bad` tints it with `--or-fail-tint`.
- `RowList` (`aria-label`) and `ListRow`: `href`, `title` (clamped to two lines; it names
  the row link), `kindLabel` (e.g. "Request · failed", also the `StatusDot`'s name),
  `tone`, `time?` (fixed-width mono slot), `meta?` badges, `selected?`
  (`aria-current="true"`), `select?` (`{ checked, onChange, label }`, a `Checkbox`) and
  `actions?`. The whole row is clickable through an absolutely positioned row link; the
  checkbox and actions are its siblings. Tab order: checkbox, row link, actions.
- `ActivityList`: `entries` (`{ id, at, text }`, `at` a `Date` or ISO string, `text` a
  sentence node), optional `aria-label` (default "Activity") and `limit` (default 10). An
  `<ol>` with a fixed-width mono date column (`activityDate(at)`, local "Oct 24 14:02") and
  the sentence; past `limit` entries a ghost "Show all {n}" button reveals the rest.
- `nestedInteractiveElements(root)`: every `a`, `button` or `input` inside an `a` or
  `button`. Lists and tables return none; screen tests can assert the same.

## Layout

- `SplitView`: a list beside its selected item's detail. Props: `list`, `detail` (or
  null), `view` (`"list"` | `"detail"`), `backLink?` (`{ label, href }`, "‹ {label}" on the
  detail), `listLabel` (names the list `region`), `detailLabel?` (default "Details"),
  `listWidth?` (`{ wide, narrow }` px, default 340/300; `wide` applies from a 1200 px
  viewport) and `fixedPane?` (`"list"`, default, or `"detail"`, which gives the width to the
  detail and lets the list fill the rest). The panes sit in a size container
  (`container: or-split / inline-size`): from a container width of 880 px both show; below
  it only the pane `view` names does, the detail with its back link. That one rule covers
  phone width and a content area narrowed by a side panel. No Next.js imports, no hints.
- `useSplitWide(ref)`: whether the element is at least 880 px wide
  (`SPLIT_WIDE_MIN_WIDTH`, followed with a `ResizeObserver`; false until measured).

## Shell

- `AppFrame`: the app layout. Props: `currentPath`, `brandHref`, `nav` (`NavItem[]`),
  `orgPicker?` (node), `user` (`{ name, image?, initials }`), `userMenu(trigger)` (wrap
  the trigger in a menu, e.g. `<Menu trigger={trigger} …/>`; called for the sidebar
  footer, the phone avatar and the drawer footer) and `children` (in the `main`
  landmark). It knows nothing about routes or sessions. An `orgPicker` trigger takes the
  `or-org-picker` class (full width; on the rail, centered), with its label and chevron in
  `or-org-picker__label` / `or-org-picker__chevron` plus `or-rail-hidden`.
  - 1200 px and wider: a 232 px `nav` "Primary" sidebar: `BrandLockup`, `orgPicker`, the
    `placement: "main"` entries, a flexible gap, the `bottom` entries and the user
    footer button (avatar and name).
  - 769–1199 px: a 64 px icon rail. Labels, the wordmark and the footer name are hidden
    with clip (still read by assistive tech); each entry shows its label as a tooltip and
    counts move to the icon's corner. Give the picker's own label the `or-rail-hidden`
    class so it hides on the rail too.
  - 768 px and narrower: a 52 px sticky top bar (`header`: hamburger "Open menu", with
    ", N alerts" and an alert dot when drawer entries have indicators, the lockup and the
    avatar), a fixed bottom tab bar (`nav` "Primary", the `phone: "tab"` entries) and a
    300 px left drawer (Radix dialog "Menu": lockup, "Close menu", picker, the
    `phone: "drawer"` entries and the user footer). Escape, the close button, a scrim
    click or following a link closes it, and focus returns to the hamburger.
- `NavItem`: `{ id, label, href, icon, placement: "main" | "bottom", phone: "tab" |
"drawer", activeFor?, indicator? }`. `indicator` is `{ kind: "count", value, label }`
  (the accent pill) or `{ kind: "dot", tone: "run" | "fail", label }` (a `StatusDot`
  pip); its `label` joins the entry's accessible name ("Inbox, 4 need you").
- `isNavActive(currentPath, item)`: true when the path equals the `href` or an
  `activeFor` prefix, or starts with one followed by `/` (`/settings` never matches
  `/settingsx`; `/` only matches itself). The active entry gets `aria-current="page"`.
- There is no search control (a non-goal of the 2.0 shell).

## Scripts

`pnpm --filter @omniralph/ui build | typecheck | lint | test`. Tests run in jsdom; layout
facts jsdom can't compute (token values, contrast) are tested by parsing the CSS files.
