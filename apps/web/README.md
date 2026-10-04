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
