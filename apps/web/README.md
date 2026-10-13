# @omniralph/web

The Omniralph control panel: a Next.js 16 app created from `mcmaster-app-template`
and built with `@iamthemcmaster/ui` (Precision Aurora v3).

Run it from the repo root with `pnpm dev`, or from here with `pnpm dev`.

## UI conventions

- All UI uses `@iamthemcmaster/ui` components, `@tabler/icons-react` icons and `sonner` toasts.
  No other component or styling library.
- Library components need `"use client"`. `page.tsx` files are server components that load data
  and render a `"use client"` view component with serializable props; mutations are server actions.
- Custom styling uses design tokens only (`--bg-*`, `--text-*`, `--border-*`, `--space-*`,
  `--radius-*`, `--font-*`, `--spring-*`, `--t-*`).
- Keep the `AppShell` layering: `AuroraField` paints at `z-0`, so the shell keeps
  `position: relative; z-index: 1`.
- Sidebar navigation lives in `src/lib/navigation.ts`.

## Fixture data and screenshots

`scripts/fixtures/README.md` covers the fixture database (`fixtures:up` / `fixtures:down`) and
the dev-only sign-in.

`verify:screens` screenshots every screen of the panel, signed in against the fixture
database, at 1440px and 390px in the dark and light themes:

```sh
pnpm --filter @omniralph/web verify:screens
pnpm --filter @omniralph/web verify:screens --routes "settings-*,/coding/**" --theme dark --viewport 390
```

**Prerequisites:** Docker only (a local or remote daemon). No secrets, no OAuth, no browser on
the host. It runs unattended:

1. builds the workspace packages the panel imports (`--skip-build` skips it);
2. starts the fixture database and `next dev` on a free port;
3. runs `scripts/screens/capture.mjs` in `mcr.microsoft.com/playwright:v<version>-noble`, the
   version of the `playwright-core` dev dependency, with `--network host`. The script and
   `playwright-core` go in, and the screenshots come out, with `docker cp` (no bind mounts);
4. signs in with the dev sign-in and captures each route of `scripts/screens/routes.ts`;
5. runs `impeccable detect --json` on each page's HTML snapshot, if the CLI is available
   (`$IMPECCABLE_CLI`, `impeccable` on `PATH`, or the Claude Code plugin's launcher);
6. stops the panel and removes the fixture database.

Output goes to `apps/web/.screens/<timestamp>/` (gitignored), one set per route, viewport and
theme: `<route>.<desktop|phone>.<dark|light>.png` (full page), `.html` (DOM with styles
inlined) and `.impeccable.json` (detect findings), plus `results.json` (HTTP status, final path,
`scrollWidth`, console errors). The screenshot paths go to stdout, the summary to stderr.

| Option              | Effect                                                                |
| ------------------- | --------------------------------------------------------------------- |
| `--routes <glob>`   | Routes whose name or path matches (comma-separated; `*`, `**`)        |
| `--theme <list>`    | `dark`, `light` (default both)                                        |
| `--viewport <list>` | `desktop`/`1440`, `phone`/`390` (default both)                        |
| `--strict`          | Exit non-zero when a route is wider than its viewport (`scrollWidth`) |
| `--skip-build`      | Don't build the workspace packages first                              |

Routes wider than their viewport are always reported; failed captures always exit non-zero.
A new `page.tsx` needs an entry in `scripts/screens/routes.ts` (a test checks every page is
listed), with fixture IDs from `scripts/fixtures/ids.ts` for its dynamic segments.
To capture a state that needs interaction (unsaved changes, an open confirmation), add a
route with `steps`: `{ action: "fill", selector, value }` or `{ action: "click", selector }`,
run in order before the screenshot (e.g. `settings-profiles-confirm`).
