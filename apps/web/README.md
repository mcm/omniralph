# @omniralph/web

The Omniralph control panel: a Next.js 16 app created from `mcmaster-app-template`
and built with `@omniralph/ui` (Ultraviolet).

Run it from the repo root with `pnpm dev`, or from here with `pnpm dev`.

## UI conventions

- All UI uses `@omniralph/ui` components and toasts and `@tabler/icons-react` icons. No other
  component or styling library: `@iamthemcmaster/ui` (1.x) is retired, and lint refuses an import
  of it. `src/app/globals.css` holds the base layer every page is written against.
- Library components need `"use client"`. Pages read and write through the `/api/ui` route handlers
  with TanStack Query (see [Data fetching](#data-fetching)).
- Links use `Link` from `src/components/link.tsx`, not `next/link` (lint-enforced under `(app)` and
  in `src/components`): it shows a pending state while the page it opens loads (`useLinkStatus`).
- Custom styling uses the `--or-` design tokens only (`--or-page`, `--or-text`, `--or-acc`,
  `--or-radius` …).
- Sidebar navigation lives in `src/lib/navigation.ts`.

## Data fetching

Every page under `src/app/(app)` is a thin client entry that renders a client view; the view
reads and writes through Route Handlers under `src/app/api/ui/**/route.ts` with TanStack Query.
No page reads the database and there are no server actions: `(app)/layout.tsx` only gates the
session and hands the user (and their organizations) to `AppShell`, which provides the
`QueryClient` (`QueryProvider`). The `data-path/no-server-data` lint rule
(`lint-rules/data-path.mjs`) enforces it for every file under `src/app/(app)`, tests included:
no `"use server"`, no `revalidatePath`/`revalidateTag`, no `@omniralph/db` or `@/lib/db` imports,
except in the layout. Route handlers that aren't the panel's API (the GitHub App's install and
callback under `src/app/(oauth)`, OAuth connects under `src/app/api/integrations`) live outside
`(app)`, and so do tests that need the database (next to the handlers they drive, under
`src/app/api/ui`).

**Handlers** (`src/lib/api/handler.ts`). Wrap every handler in `apiHandler`:

```ts
export const PATCH = apiHandler(
  { access: "admin", body: renameAgentSchema },
  async ({ user, body, params }) => renameAgent(user, params.id, body),
);
```

It resolves the user with the session helpers (`access`: `member` by default, `admin`, or
`signed-in` for actions without an organization), validates the body and search params with zod,
and answers every failure as JSON `{ error, code?, fieldErrors? }`: 401 signed out, 403 without the
role or an organization, 409 `organization_switched` when the request's organization (the
`x-omniralph-organization` header the client sends) isn't the active one, 400 for invalid JSON,
a schema mismatch or a failed `ActionResult`, 404 for `ApiRouteError.notFound()` or `notFound()`,
500 otherwise. Handlers only parse, authorize and serialize: the logic lives in `src/lib/**`
(moved out of the old `actions.ts` files) and may keep returning `ActionResult`, whose `error`
and `warning` wording reaches the UI unchanged. Scope every query to `user.organization.id`.

**Schemas** (`src/lib/api/schemas.ts`, plus one module per area in `src/lib/api/`). Request and
response bodies are zod schemas imported by both the handler and the client. Dates cross the wire
as ISO strings (`isoDate`); mutations answer `mutationResultSchema` (`{ ok: true, warning? }`),
extended when they return more.

**Client** (`src/lib/api/client.ts`). `api.get(path, schema, { params, organizationId, signal })`
(and `post`/`patch`/`put`/`delete` with `body`) parses the response with the schema and throws an
`ApiError` (`status`, `code`, `fieldErrors`, and the server's message) on a non-2xx, a response
that isn't the expected JSON, or a network failure. Pass the query key's organization id, so the
handler can refuse it after a switch in another tab.

**Query keys** (`src/lib/api/keys.ts`). Every key comes from `queryKeys(organizationId)` (in
components, `useQueryKeys()`) and starts with the active organization's id: `keys.jobs.list(params)`,
`keys.jobs.detail(id)`, `keys.agents.part(id, "runs", params)`. Keys nest by prefix
(`keys.jobs.all` ⊃ `keys.jobs.lists` ⊃ `keys.jobs.list(params)`), and switching organizations drops
the other organizations' queries from the cache.

**Switching organizations.** The switcher (`POST /api/ui/organizations/switch`) and leaving an
organization change the organization cookie, then `router.refresh()`: the layout re-renders the
shell in the new organization, `QueryProvider` drops the previous one's cache, and every mounted
query loads under the new keys. A switch made in this tab calls `useExpectOrganizationSwitch()`
once it succeeded, so `OrganizationGuard` doesn't take the new cookie for another tab's switch.
The guard blocks a tab after another tab's switch when it regains focus, or when a query is
refused with 409 `organization_switched` (a visible tab polling beside the one that switched).

```ts
const keys = useQueryKeys();
const { organization } = useCurrentUser();
const repositories = useQuery({
  queryKey: keys.repositories.list({ page }),
  queryFn: ({ signal }) =>
    api.get("/api/ui/repositories", repositoryListSchema, {
      params: { page },
      organizationId: organization.id,
      signal,
    }),
  placeholderData: keepPreviousData,
});
```

Paginated lists keep `page` (and filters) in the URL (`useSearchParams`) and use `placeholderData:
keepPreviousData`; wrap the table in `.list-pending` with `aria-busy={query.isPlaceholderData}`, so
the previous page stays, dimmed, while the next one loads (`repositories-view.tsx`). A filter
select shows the chosen value at once: hold the choice in state keyed to the URL it was made on,
query with it, and `router.push` the new URL.

**Live updates** (`src/lib/live`, `src/components/live`). The UI is live without polling:
the server publishes a change event (IDs only, `src/lib/live/events.ts`) on Ably for every write,
on `org:<id>:changes` or on the user's own `user:<id>:changes`. `LiveProvider` (mounted by
`AppShell` inside `QueryProvider`) connects with a subscribe-only token from
`GET /api/ui/live/token`, subscribes to the channel of every organization in the current scope (one,
or every membership under "All organizations") plus the user's own, and invalidates exactly the
queries each event affects, as mapped in `src/lib/live/invalidations.ts`. Changes to the user's own
record (their theme, their memberships) re-render the shell from the server (`router.refresh()`).

- **Polling is a fallback** (`src/lib/api/query-client.ts`). While connected, the default
  `refetchInterval` is `false`; while the connection is down (or the token endpoint fails), and
  when realtime isn't configured (no `ABLY_API_KEY`, as in local development), mounted queries poll
  every `FALLBACK_POLL_INTERVAL` (10s). Returning after a drop refetches the active queries once.
  Queries still refetch when the tab regains focus or the network reconnects, and on every mount
  (`staleTime: 0`). Network and 5xx failures retry with backoff; 4xx answers don't. Handlers stay cheap all the same (paginated,
  indexed, `getDb()` on the Node runtime): every event refetches every open tab's matching queries.
- **"All organizations".** Every query key starts with the active organization's id, also under
  "All organizations", where the scope-wide screens (the Inbox and Runs, `SCOPE_WIDE_AREAS`) ask
  for `organization=all` (`useScopeParam()` in `src/screens/scope.ts`) and key by it. An event of
  any organization in the scope reaches those areas' queries under the active organization's keys.
  Analytics keys each query by its scope too and a `run` event refetches only those covering its
  organization (`analyticsKeys(keys).covering`: that organization's and the `all` ones).
- **Throttling.** A query that refetches an expensive aggregate sets `meta: { liveThrottleMs: n }`:
  events invalidate it at most once per `n` ms, the last one of a burst delivered when the window
  ends (Analytics: `ANALYTICS_LIVE_THROTTLE_MS`, 10s).
- **Status.** `useLiveStatus()` (`live`, `connecting`, `down`, `off`) is there for screens; the
  shell shows `LiveNotice` ("Live updates stopped. Retrying…", with Retry now) only after the
  connection has been down for more than 5s (Design rule 9). Never show a "connected" or "Live"
  indicator.

**The convention every screen follows:**

1. All data goes through TanStack queries keyed by `queryKeys` (`useQueryKeys()`), never fetched
   outside the cache, so change events can reach it.
2. Every new change event, resource or settings section is mapped in
   `src/lib/live/invalidations.ts` to the queries that show it, narrowed by `ids`, `runId`,
   `section` and `subjectId` (the map is exhaustive: an unmapped resource fails typecheck), with a
   unit test of its keys.
3. Every mutation declares `optimistic` or `applyResult` (see Mutations), so the view never waits
   on a refetch.
4. Every screen adds two tests: a published change event (delivered through the fake Ably client
   in `src/components/live/live-test-utils.ts`, or applied with `createLiveInvalidator`)
   invalidates the screen's queries, and each mutation updates the view without waiting on a
   refetch.

**External APIs are not polled.** A query that calls Linear, GitHub or GitLab (the repository
pickers, Linear lookups) is its own query with `refetchInterval: false` and `refetchOnWindowFocus:
false`, refreshed by an explicit button; polled handlers never call an external API. Example:
`useSelectableRepositories` in `src/screens/repos/queries.ts` (its handler answers 502
`listing_failed` with the code host's error, which the add-repo sheet's picker shows).

**Mutations** (`src/components/use-api-mutation.ts`). Use `useApiMutation`. `invalidate` is
required: list every list and detail the mutation can affect, by key prefix. Declare how the view
shows the change at once, too:

```ts
const rename = useApiMutation({
  mutationFn: (name: string, { organizationId }) =>
    api.patch(`/api/ui/agents/${id}`, mutationResultSchema, { body: { name }, organizationId }),
  optimistic: (name, cache) =>
    cache.set<Agent>(cache.keys.agents.detail(id), (agent) => agent && { ...agent, name }),
  invalidate: (keys) => [keys.agents.all],
  success: "Agent renamed",
});
```

- `optimistic(variables, cache)` runs before the request: `cache.set(prefix, updater)` cancels the
  in-flight fetches of every cached query under the prefix (so a fetch that started earlier can't
  overwrite the change), snapshots them and writes the updater's result. On failure every snapshot
  is restored exactly, with the danger toast.
- `applyResult(data, cache)` writes the server's response (`cache.set`) before `onSuccess`, for what
  the view can't predict (a created ID, a computed field).
- With either, the `invalidate` keys are refetched in the background once the mutation settles
  (reconcile), and nothing waits on that refetch.

Without either (older code), the keys are invalidated and their refetch awaited before
`onSuccess` runs, so a `router.push` from `onSuccess` never lands on cached-stale data. Only mounted
queries refetch: when `onSuccess` navigates to a page whose list isn't mounted (a picker's Save
going back to a list page), pass `{ queryKey: keys.repositories.lists, refetchType: "all" }` so
its cached copy is refetched too and the page shows the change on arrival. The hook shows the
success toast (or the result's `warning` as a warning toast), the server's message as a danger
toast on failure (`onError` gets the `ApiError`, with `fieldErrors` for inline errors), and refuses
to run once another tab has switched organizations. A mutation shown as a pending overlay instead
gives itself a `mutationKey` and overlays the pending mutations' variables (`useMutationState` with
`status: "pending"`) on the query data (`useFindingFeedback` in `reviews/[id]/finding-feedback.tsx`).

**Loading, errors and freshness.** A screen shows placeholders shaped like its content while the
first load is pending (no spinner text) and an in-place error with "Try again" when it fails; a
refetch that fails keeps the figures shown and says so in a danger toast. There is no "Updated 3s
ago" line: the shell's `LiveNotice` covers stopped live updates (Design rule 9). Relative times
tick on the browser's clock (`useClock()` in `src/screens/clock.ts`), never a server render time.

**Forms** seed from query data and re-seed only while not dirty, so a background refetch never
overwrites an edit: `useSeededDraft(saved)` (`src/components/use-seeded-draft.ts`). A
`SettingsSection`/`SettingsCard` save (a TanStack mutation, `useSettingsSave`) calls the API with
`useApiAction()` (`src/components/use-api-action.ts`): one request, then one invalidation, awaited
before the form leaves its saving state. A save made of several changes is one request whose
handler stops at the first failure and names the changes it didn't save. Changes an agent picks up
with its next heartbeat answer a `savedAt` and show "Saved — waiting for <agent> to pick it up",
then "Applied" once the agent's `lastHeartbeatAt` is later (`SettingsSection`'s `savedStatus`).

**Resources of another organization.** A detail handler reads a resource of any of the user's
organizations without switching: `requireRunAccess`, `requireRepositoryAccess` and
`requireAgentAccess` (`src/lib/api/scope.ts`) answer the user's membership and role there, and 404
for an organization the user isn't a member of. A 409 `enter_organization` with a signed
`enterPath` still makes `QueryBoundary` switch organizations and come back. **List filters and pagination** live in the URL search params
(`useSearchParams`) and use `placeholderData: keepPreviousData`.

**Search and jump.** `SearchProvider` (`src/components/search/search-palette.tsx`, in
`AppShell`) opens `@omniralph/ui`'s `SearchPalette` from the frame's search buttons and ⌘K /
Ctrl+K. It calls `GET /api/ui/search?q=&limit=&organization=` itself (debounced 150 ms, the
previous request aborted; no TanStack cache: results are ephemeral): the runs, Backlog work
items, repos, agents and Settings pages of the scope, ranked exact, prefix, substring, then by
recency (`src/lib/search/search.ts`, `@omniralph/db`'s `search.ts`), or under two characters the
user's five most recently opened items. Choosing a result posts it to
`POST /api/ui/search/recent` (`user_recent_items`, 20 per user). New Settings pages go in
`src/lib/search/settings-pages.ts`.

**Navigation and render errors.** Links show a pending state while their page loads (`Link` in
`src/components/link.tsx`);
the new page's skeleton then shows within a frame, since pages render on the client.
`src/app/(app)/error.tsx` catches any unexpected render error of a page and shows it in place,
with Retry, inside the shell.

**Tests** render with `createTestQueryClient()` and `queryWrapper(client)` from
`src/components/query-test-utils.tsx` (no polling, no retries; live data tests use
`createQueryClient()` and the fake Ably client in `src/components/live/live-test-utils.ts`) and mock `fetch` (`mockFetch`
there answers routes by `"METHOD /path"` and records the requests); handler tests
mock `@/lib/auth/session` or use `@omniralph/db/testing`. `src/app/api/ui/organization-isolation.test.ts`
drives every `/api/ui` endpoint (and the signed-in layout, and the enter-organization round
trip) against two organizations: add each new endpoint there. `@tanstack/react-query-devtools`
loads in development only.

## Fixture data and screenshots

`scripts/fixtures/README.md` covers the fixture database (`fixtures:up` / `fixtures:down`) and
the dev-only sign-in.

`verify:screens` screenshots every screen and state of the panel, signed in against the fixture
database, and of the agent's local page in its fixture mode (below), at the three layouts of
DESIGN.md ("Widths and accessibility") in the dark and light themes: `desktop` 1440×900 (the full
sidebar), `rail` 1024×768 (the 64px icon rail) and `phone` 390×844 (top bar and tab bar; a mobile,
touch, 2× device):

```sh
pnpm --filter @omniralph/web verify:screens
pnpm --filter @omniralph/web verify:screens --routes "settings-*,/runs/**" --theme dark --viewport 390
pnpm --filter @omniralph/web verify:screens --app agent --strict
```

**Prerequisites:** Docker only (a local or remote daemon). No secrets, no OAuth, no browser on
the host. It runs unattended:

1. builds the workspace packages the panel imports and the agent page (`apps/agent/dist/ui`)
   (`--skip-build` skips it);
2. starts the agent page's fixture mode, and the fixture database and `next dev` on a free port,
   then requests every `/api/ui` route handler once (`scripts/browser/api-routes.ts`; it also
   compiles them). Turbopack's dev server sometimes starts without some of them, and answers
   them with Next's HTML 404 for the whole run (every Runs step panel then says "Couldn't load
   the transcript"): it is then started again on an empty Turbopack cache
   (`.next/dev/cache/turbopack`), and the run stops if a route is still missing;
3. runs `scripts/screens/capture.mjs` in `mcr.microsoft.com/playwright:v<version>-noble`, the
   version of the `playwright-core` dev dependency, with `--network host`. The scripts,
   `playwright-core` and `axe-core` go in, and the screenshots and reports come out, with
   `docker cp` (no bind mounts).
   On Docker Desktop (Mac, Windows), whose `localhost` is the VM's rather than the host's, the
   browser opens `host.docker.internal` instead, and `next dev` is started with
   `OMNIRALPH_ALLOWED_DEV_ORIGINS=host.docker.internal` so it allows that origin
   (`allowedDevOrigins` in `next.config.ts`; without it the page never hydrates);
4. signs in with the dev sign-in (as the fixture admin, and as the member for routes with
   `as: "member"`) and captures each route of `scripts/screens/routes.ts`, once its
   data has loaded: pages poll `/api/ui`, so the network never goes idle, and the capture waits
   instead until no skeleton (`[aria-busy="true"]`) is left, up to 60s, then runs the
   accessibility checks on it (below);
5. runs `impeccable detect --json` on each page's HTML snapshot, if the CLI is available
   (`$IMPECCABLE_CLI`, `impeccable` on `PATH`, or the Claude Code plugin's launcher);
6. stops the panel and the agent page, and removes the fixture database.

Output goes to `apps/web/.screens/<timestamp>/` (gitignored), one set per route, viewport and
theme: `<route>.<desktop|rail|phone>.<dark|light>.png` (full page), `.html` (DOM with styles
inlined), `.impeccable.json` (detect findings), `.axe.json` (axe-core's violations) and
`.aria.yml` (the ARIA snapshot), plus `results.json` (per capture: who it was captured as, HTTP
status, final path, `scrollWidth`, `kbdCount`, `retiredWording`, console errors, in-place load
errors, failed API responses (`failedResponses`), why a page didn't render, the Decided checks' findings: `hintText`, `liveIndicator`,
`detailToolbar`, `bareMetadata`, `rowSummary`, `phoneExpanded`, `orgFirst`, and the
accessibility findings: `axe`, `keyboard`, `keyboardStops` (each element the keyboard walk
focused, in Tab order: `{ selector, name }`, its `tag#id.class[role]` and accessible name),
`escape`, `landmarks`, `checkErrors`, and, when detect ran, `impeccable` (the snapshot's detect
findings) or `impeccableError`). The screenshot paths go to stdout, the summary to stderr.

| Option              | Effect                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--routes <glob>`   | Routes whose name or path matches (comma-separated; `*`, `**`)                                                                                                                                                                                    |
| `--theme <list>`    | `dark`, `light` (default both)                                                                                                                                                                                                                    |
| `--viewport <list>` | `desktop`/`1440`, `rail`/`1024`, `phone`/`390` (default all three)                                                                                                                                                                                |
| `--surface <list>`  | `panel`, `agent` (default both); `web` is the panel and `all` both                                                                                                                                                                                |
| `--app <list>`      | Another name for `--surface` (`web`, `agent`, `all`); give one of the two                                                                                                                                                                         |
| `--strict`          | Exit non-zero when a route is wider than its viewport (`scrollWidth`), on a load error or failed API response the route doesn't expect, on any Decided finding, or on any accessibility or `impeccable detect` finding `ignore.md` doesn't ignore |
| `--skip-build`      | Don't build the workspace packages first                                                                                                                                                                                                          |

Every capture is checked for the Design rules a machine can check (the logic is
`scripts/screens/checks.ts`). These always exit non-zero:

- a failed capture, or a page still loading after 60s or showing its error boundary
  (`(app)/error.tsx`);
- `kbdCount`: visible `kbd` elements, i.e. keyboard-shortcut indicators (rule 7), on any page but
  the panel's Help (`/help`), which lists every key (the agent page has no Help page);
- `retiredWording`: visible text saying "Ralph" or "harness" (`document.body.innerText`,
  case-insensitive); the product says "Om" for the AI and "agent" for the machine (see
  `src/user-facing-wording.test.ts` for the source-level check). Job types (`ralph.story`) and
  the `ralph-run` sink are identifiers and don't count.

Routes wider than their viewport (`scrollWidth`, at every width including `rail`) are always
reported, and exit non-zero with `--strict`.

Load errors and failed API responses are always listed, and exit non-zero with `--strict` unless
the route expects them (`expectedFailures` in `routes.ts`, for a fixture that shows a failed load
on purpose: load errors by their starting text, responses by a part of their line):

- `loadErrors`: in-place errors on the page (`scripts/screens/load-errors-page.mjs`, tested in
  jsdom): the panel's QueryBoundary (`.query-error`), the Runs `LoadError` (`.or-run-error`,
  e.g. "Couldn't load the transcript. The server sent an unexpected response.") and any empty
  state or `role="alert"` that starts "Couldn't load …" or "Can't load …" (the agent page's).
  They are read once the content has loaded and again just before the screenshot, so a step
  panel's transcript counts;
- `failedResponses`: the page's API calls (`/api/ui/…` on the panel, `/api/…` on the agent page)
  answered with a status of 400 or more, or with a body that isn't JSON (or an event stream),
  e.g. `GET /api/ui/runs/…/session: HTTP 404 (text/html; charset=utf-8)`, Next's not-found page
  for a route it didn't match.

#### Decided checks

The Decided items of `DESIGN.md` ("Decided — never flag, never undo") that a capture can show
are checked on every capture, on the panel and the agent page (where the item applies). The
in-page logic is `scripts/screens/decided-page.mjs` (tested in jsdom by `decided-page.test.ts`),
with each route's options from `decidedOptions` in `checks.ts`. The summary's "Decided" section
lists each check's findings by route, viewport and theme, and `--strict` fails on every one
(`kbdCount` fails every run). There are no exceptions: a finding is fixed, or the check is wrong.

| Check           | What it reports                                                                                                                                                                                                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kbdCount`      | Visible `kbd` outside the panel's Help page (rule 7)                                                                                                                                                                                                                                                                             |
| `hintText`      | Text about where things are (rule 3), from `src/lib/copy/banned-hints.ts`'s `BANNED_HINTS`, read per block of text                                                                                                                                                                                                               |
| `liveIndicator` | "Live", "Updated …" or "Last updated" (`LIVE_INDICATORS`), or "… ago" beside a refresh control (rules 9 and 22); only `LiveNotice`'s text and the legal pages' revision date are allowed                                                                                                                                         |
| `bareMetadata`  | A text node that is exactly an issue ID, a version, an Omniralph branch, a fixture organization, repo or agent name (`FIXTURE_METADATA_NAMES`), "PRD", "Small", "Medium", "Large" or "Size …", outside a badge (`[data-or-badge]`) and not in a sentence (rules 1 and 2). Titles, controls, `time`, code and Markdown are exempt |
| `rowSummary`    | A `ListRow` with more than its kind and state line, title and badges (rule 8)                                                                                                                                                                                                                                                    |
| `detailToolbar` | On `detail` routes: no `role="toolbar"`, a toolbar button with visible text, without a name or without a tooltip, no "More actions" menu (the panel), or a text-labeled button in the header outside `needsYou` routes (rules 5 and 6)                                                                                           |
| `phoneExpanded` | On `detail` routes at `phone`: a `details[open]` or `aria-expanded="true"` disclosure on load, before the steps (rule 16)                                                                                                                                                                                                        |
| `orgFirst`      | On the panel's `list` and `detail` routes: under All organizations (`org: "all"`), a row or detail header whose first badge isn't `data-or-badge="org"`; with one organization, one that shows it (rule 13)                                                                                                                      |

#### Accessibility checks

After its screenshot, every capture (each route, viewport and theme, on the panel and the agent
page) is checked for WCAG 2.2 AA semantics, contrast and keyboard operation. The in-page logic is
`scripts/screens/a11y-page.mjs` (tested in jsdom by `a11y-page.test.ts`); capture.mjs runs it.

| Check       | What it reports (the `rule` of each finding)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `axe`       | axe-core's violations of the rules tagged `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` (`color-contrast`, `target-size`, `nested-interactive`, `aria-*`, `label`, `button-name`, `link-name`, …) and the `landmark-*` rules, by axe rule ID                                                                                                                                                                                                                                                                                                                                                                     |
| `keyboard`  | Tab from the top of the page until the focus comes back to its first stop (or 300 stops): `unreachable` (a visible, enabled link, button, input, `[role=switch\|checkbox\|tab\|menuitem\|option]` or `[tabindex="0"]` the focus never reached; inside an open modal, only what it holds; one member of a roving widget such as a tab list or toolbar counts for all), `no-focus-indicator` (its `outline` and `box-shadow`, its `::before`/`::after`'s and its parent's, are the same focused as unfocused; or it is hidden), `trap` (the focus keeps cycling through elements that aren't all inside an open modal or menu) |
| `escape`    | Only on routes whose `steps` open a dialog, sheet, menu or popover (`dialog`, `alertdialog`, `menu`, `listbox`, `aria-modal`): after Escape, `stays-open` (still visible after 2s) and `focus-not-restored` (the focus isn't on the last clicked step target, the control that opened it). The overlay is opened again for the keyboard walk                                                                                                                                                                                                                                                                                 |
| `landmarks` | `no-main`, `many-main` and `no-h1` (hidden elements don't count) and, at `rail`, `unnamed-nav-link`: a navigation link with an empty accessible name (the rail hides the labels visually; they must stay accessible)                                                                                                                                                                                                                                                                                                                                                                                                         |

The summary prints a section per check: each finding (rule, impact, target, summary) and the
captures (route, viewport, theme) it was seen on. A check that couldn't run fails every run;
the findings fail `--strict`, except those an accessibility entry of
`.impeccable/critique/ignore.md` ignores: its rule is `<check>: <rule>` (`axe: color-contrast`,
`keyboard: unreachable`) and its scope is one or more backticked `key: value` pairs, all of
which must match: `route` (a name or path glob, like `--routes`), `surface`, `viewport`,
`theme`, and `target` (part of the finding's target). An entry with no scope ignores nothing,
and the critique's own entries (impeccable rules, `decided:` items) never ignore an
accessibility finding (`scripts/screens/ignore.ts`).

#### impeccable detect

When the impeccable CLI is found, `impeccable detect --json` runs on each capture's HTML
snapshot (the page's DOM with its styles inlined; scripts and the hidden dev UI removed). The
summary's "impeccable detect" section lists each rule with what it saw and the captures it was
seen on, and `--strict` fails on every finding that no detect row of
`.impeccable/critique/ignore.md` ignores, and on a snapshot detect couldn't scan. A detect row
is any row whose rule is a detector rule (not `decided:`, not `<check>: <rule>`); it ignores
that rule's findings that name something its Scope cell names in backticks: a class selector
(`` `.or-ref` ``; every class of `` `.a.b` ``, as whole class names), a file
(`` `packages/ui/styles/refs.css` ``, for a source scan), a custom property (`` `--or-glow` ``)
or a color (`` `#f5f3ee` ``, also matched as `rgb(245, 243, 238)`), or the captures of a route
(`` `route: <name glob>` ``, for a page-wide finding whose snippet names no element, such as
`em-dash-overuse`). A row naming none of these ignores nothing and is reported (`scripts/screens/ignore.ts`). A `decided:` row names an item,
not a detector rule, so a detect finding that a Decided item rejects gets its own row naming
what it rejects (e.g. `dark-glow` on `.or-btn--primary`, "Rejected: rule 15").

To read the reports of a capture:

- `<screen>.axe.json`: `{ testEngine, url, rules, violations }`, where `rules` are the axe rules
  that ran and each violation has its `id`, `impact`, `help`, `helpUrl` and `nodes`: per element
  its `target` (CSS selector path), `html` and `failureSummary` (for `color-contrast`, the
  ratio, the colors and the ratio needed). `results.json`'s `axe` has one line per element:
  `{ rule, impact, target, summary }`.
- `<screen>.aria.yml`: Playwright's ARIA snapshot of the page (`locator("body").ariaSnapshot()`),
  the accessibility tree as YAML: one line per node, `- role "accessible name" [state]`, nested
  by containment, e.g. `- navigation "Main":` then `- link "Inbox"`. A link or button with no
  quoted name has no accessible name; `heading … [level=1]` is the page's `h1`. It is what a
  screen reader announces, for the critique to read beside the screenshot.

A new `page.tsx` needs an entry in `scripts/screens/routes.ts` (a test checks every page is
listed), with fixture IDs from `scripts/fixtures/ids.ts` for its dynamic segments.
To capture a state that needs interaction (unsaved changes, an open confirmation), add a
route with `steps`: `{ action: "fill", selector, value }` or `{ action: "click", selector }`,
run in order before the screenshot (e.g. `fleet-agent-revoke`). A route may also set:

| Field          | Effect                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `board`        | The canvas board(s) it is reviewed against (DESIGN.md, "Canvas boards"). A test checks every board but CursorAvatars has a route, and that the phone boards' routes are captured at `phone` |
| `as: "member"` | Signed in as the fixture member, not the admin. Settings, Repos and Fleet are captured this way too (`member-*`), to review admin-only controls in their read-only form                     |
| `organization` | Opens it in that organization (the organization cookie), e.g. the empty Inbox of the sandbox organization                                                                                   |
| `viewports`    | Only at these widths, for states that exist at some only (the phone menu; the Ask panel beside the sidebar and rail)                                                                        |
| `waitFor`      | A CSS selector to wait for first, for content that loads without a skeleton (Up next in the empty Inbox)                                                                                    |
| `list`         | A list screen (`LIST_PAGES`): its rows are checked by `orgFirst`. A test checks every route of a list page sets it                                                                          |
| `detail`       | A detail view (`DETAIL_PAGES`, or an Inbox item): checked by `detailToolbar`, `phoneExpanded` and `orgFirst`. A test checks every detail view sets it                                       |
| `needsYou`     | The detail shows a needs-you decision (the Inbox items), whose labeled buttons may sit in its header                                                                                        |
| `org: "all"`   | Captured with "All organizations" selected (the organization scope cookie); `all-orgs-*` covers every list screen and the main detail views                                                 |

### The agent's local page

The agent page (`apps/agent/ui`) is captured the same way, with the same container and
`capture.mjs`, against its fixture mode: `apps/agent/scripts/ui-fixture/fixture.ts` serves the
built page with the agent's real page server and API routes over seeded local state with stable
names (`FIXTURE_ATTEMPTS`, `FIXTURE_INSTALLS`, …): settings with slots, pool limits, accepted
kinds, host tool paths (`terraform` configured at a missing path, which a playbook requires) and a
version pin; installables installed, updating and failed; workspace and disk usage; Claude
signed in with its models; log lines; a running attempt with its live transcript and log tail;
finished attempts; and repos whose last sync failed for one. Saves work (a saved host tool path
is checked as the next heartbeat would), and installs finish a moment later without running npm.

It starts only with `OMNIRALPH_AGENT_UI_FIXTURE=1`, and lives outside `apps/agent/src`, so the
published package never has it (`scripts/smoke-agent-package.sh` checks the tarball). To open it
in a browser:

```sh
pnpm --filter @omniralph/agent build:ui
OMNIRALPH_AGENT_UI_FIXTURE=1 pnpm --filter @omniralph/agent exec \
  tsx --conditions=@omniralph/source scripts/ui-fixture/serve.ts
```

It prints `{ url, link, routes }`; open `link`, which signs the browser in. Its screens are
`apps/agent/scripts/ui-fixture/routes.ts` (every name starts with `agent-`, so
`--routes "agent-*"` works too), each with `waitFor` selectors (the page renders nothing until
its data loads) and, where needed, `steps` (the running attempt opens its Log). A test
(`apps/agent/ui/src/screens.test.ts`) checks they cover every section of the page's nav. The
agent page's "Can't load …" states count as in-place load errors.

## End-to-end tests

`e2e` runs the Playwright specs in `e2e/*.spec.ts` against the real panel on the fixture
database, to check behaviour a person would otherwise click through (live updates, a
agent enrolling while the dialog is open):

```sh
pnpm --filter @omniralph/web e2e
pnpm --filter @omniralph/web e2e --grep "smoke|enroll"
```

**Prerequisites:** Docker only, like `verify:screens`, with which it shares
`scripts/browser/environment.ts` (fixture database, `next dev`, the Playwright container,
`docker cp`, Docker Desktop's `host.docker.internal` and dev origins). It runs unattended:

1. bundles each spec and `e2e/playwright.config.ts` with esbuild (the workspace packages
   from source), so specs can import `@omniralph/db` and `scripts/fixtures/ids.ts`;
2. builds the workspace packages the panel imports (`--skip-build` skips it), starts the
   fixture database (reseeded) and `next dev` on a free port;
3. runs `playwright test` on the bundles in `mcr.microsoft.com/playwright:v<version>-noble`
   (the bundles and `@playwright/test` go in with `docker cp`), with `E2E_BASE_URL` (the
   panel) and `DATABASE_URL` (the fixture database) as the container reaches them;
4. prints Playwright's list of tests and its pass/fail summary, copies the traces and
   screenshots of failed tests to `apps/web/.e2e/<timestamp>/` (gitignored), stops the panel
   and removes the fixture database, also on failure. It exits non-zero when a test fails.

| Option                  | Effect                                                |
| ----------------------- | ----------------------------------------------------- |
| `--grep <regex>`        | Only tests whose title (file, describe, test) matches |
| `--grep-invert <regex>` | Skip tests whose title matches                        |
| `--skip-build`          | Don't build the workspace packages first              |

**Writing a spec:** import `test` and `expect` from `./fixtures` (not `@playwright/test`).
The fixtures and helpers there:

- `signIn(user?)` signs the test's browser context in as a fixture user (`"admin"`, the
  default, or `"member"`; `FIXTURE_EMAILS`). `page` and `context.request` then share the
  session, so `context.request` calls `/api/ui/*` as that user.
- `db` is the fixture database (`@omniralph/db`): write rows directly to play an agent, a
  webhook or a cron, and read them back. Name fixture rows with `FIXTURE_IDS`.
- `request` (Playwright's) calls the panel's HTTP API without a session, e.g. the agent
  API: `enrollAgent(request, await createEnrollmentToken(db), name)` enrolls an agent
  through `POST /api/agent/enroll`.
- `e2e/runs.ts` creates runs as the dispatcher and agents leave them, each under a unique
  title: `triageRun(db, prefix, status)` (running, failed, or finished with a PRD ready in
  the Inbox), `finishTriage`, `runningReview` and `addFinding`. Its `open(page, path, api)`
  waits for the route's first answer.

Tests run one at a time (one worker) on one seed, so a spec that changes shared fixture rows
puts them back, or creates its own rows instead (e.g. a new agent with a unique name).
Without Ably, live data polls every 10s (changes made in the browser show at once): assert with
`expect(...).toBeVisible()` and friends, which retry for 20s, rather than reloading. The first visit of each route waits for `next dev` to
compile it (navigation timeout 3 minutes).
