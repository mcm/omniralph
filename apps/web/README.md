# @omniralph/web

The Omniralph control panel: a Next.js 16 app created from `mcmaster-app-template`
and built with `@iamthemcmaster/ui` (Precision Aurora v3).

Run it from the repo root with `pnpm dev`, or from here with `pnpm dev`.

## UI conventions

- All UI uses `@iamthemcmaster/ui` components, `@tabler/icons-react` icons and `sonner` toasts.
  No other component or styling library.
- Library components need `"use client"`. Pages read and write through the `/api/ui` route handlers
  with TanStack Query (see [Data fetching](#data-fetching)).
- Links use `Link` from `src/components/link.tsx`, not `next/link` (lint-enforced under `(app)` and
  in `src/components`): it shows a pending state while the page it opens loads (`useLinkStatus`).
- Custom styling uses design tokens only (`--bg-*`, `--text-*`, `--border-*`, `--space-*`,
  `--radius-*`, `--font-*`, `--spring-*`, `--t-*`).
- Keep the `AppShell` layering: `AuroraField` paints at `z-0`, so the shell keeps
  `position: relative; z-index: 1`.
- Sidebar navigation lives in `src/lib/navigation.ts`.

## Data fetching

Every page under `src/app/(app)` is a thin client entry that renders a client view; the view
reads and writes through Route Handlers under `src/app/api/ui/**/route.ts` with TanStack Query.
No page reads the database and there are no server actions: `(app)/layout.tsx` only gates the
session and hands the user (and their organizations) to `AppShell`, which provides the
`QueryClient` (`QueryProvider`). The `data-path/no-server-data` lint rule
(`eslint-rules/data-path.mjs`) enforces it for every file under `src/app/(app)`, tests included:
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

`verify:screens` screenshots every screen of the panel, signed in against the fixture
database, at 1440px and 390px in the dark and light themes:

```sh
pnpm --filter @omniralph/web verify:screens
pnpm --filter @omniralph/web verify:screens --routes "settings-*,/runs/**" --theme dark --viewport 390
```

**Prerequisites:** Docker only (a local or remote daemon). No secrets, no OAuth, no browser on
the host. It runs unattended:

1. builds the workspace packages the panel imports (`--skip-build` skips it);
2. starts the fixture database and `next dev` on a free port;
3. runs `scripts/screens/capture.mjs` in `mcr.microsoft.com/playwright:v<version>-noble`, the
   version of the `playwright-core` dev dependency, with `--network host`. The script and
   `playwright-core` go in, and the screenshots come out, with `docker cp` (no bind mounts).
   On Docker Desktop (Mac, Windows), whose `localhost` is the VM's rather than the host's, the
   browser opens `host.docker.internal` instead, and `next dev` is started with
   `OMNIRALPH_ALLOWED_DEV_ORIGINS=host.docker.internal` so it allows that origin
   (`allowedDevOrigins` in `next.config.ts`; without it the page never hydrates);
4. signs in with the dev sign-in and captures each route of `scripts/screens/routes.ts`, once its
   data has loaded: pages poll `/api/ui`, so the network never goes idle, and the capture waits
   instead until no skeleton (`[aria-busy="true"]`) is left, up to 60s;
5. runs `impeccable detect --json` on each page's HTML snapshot, if the CLI is available
   (`$IMPECCABLE_CLI`, `impeccable` on `PATH`, or the Claude Code plugin's launcher);
6. stops the panel and removes the fixture database.

Output goes to `apps/web/.screens/<timestamp>/` (gitignored), one set per route, viewport and
theme: `<route>.<desktop|phone>.<dark|light>.png` (full page), `.html` (DOM with styles
inlined) and `.impeccable.json` (detect findings), plus `results.json` (HTTP status, final path,
`scrollWidth`, visible "Ralph" text, console errors, in-place load errors, and why a page didn't
render). The screenshot paths go to stdout, the summary to stderr.

| Option              | Effect                                                                |
| ------------------- | --------------------------------------------------------------------- |
| `--routes <glob>`   | Routes whose name or path matches (comma-separated; `*`, `**`)        |
| `--theme <list>`    | `dark`, `light` (default both)                                        |
| `--viewport <list>` | `desktop`/`1440`, `phone`/`390` (default both)                        |
| `--strict`          | Exit non-zero when a route is wider than its viewport (`scrollWidth`) |
| `--skip-build`      | Don't build the workspace packages first                              |

Routes wider than their viewport are always reported; failed captures always exit non-zero, and
so does any page whose visible text (`document.body.innerText`) says "Ralph": the product says
"Coding" (see `src/user-facing-wording.test.ts` for the source-level check). Job types
(`ralph.story`) and the `ralph-run` sink are identifiers and don't count. A page still loading
after 60s, or showing its error boundary (`(app)/error.tsx`), exits non-zero too; in-place load
errors (e.g. the GitHub picker, which can't reach GitHub with fixture credentials) are listed.
A new `page.tsx` needs an entry in `scripts/screens/routes.ts` (a test checks every page is
listed), with fixture IDs from `scripts/fixtures/ids.ts` for its dynamic segments.
To capture a state that needs interaction (unsaved changes, an open confirmation), add a
route with `steps`: `{ action: "fill", selector, value }` or `{ action: "click", selector }`,
run in order before the screenshot (e.g. `settings-profiles-confirm`).

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
