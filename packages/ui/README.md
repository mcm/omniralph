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
        onPreferenceChange={(next) => void saveThemePreference(next)}
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
  It sets `data-theme` on `document.documentElement` and, on `system`, follows
  `prefers-color-scheme` as the OS changes (dark when the OS states no preference).
  `useTheme()` returns `{ preference, resolved, setPreference }`, and `resolveTheme(preference,
prefersLight)` is the pure rule behind it. To avoid a flash before hydration, set
  `data-theme` with an inline script before paint (`THEME_BOOTSTRAP` in `apps/web`).

## Scripts

`pnpm --filter @omniralph/ui build | typecheck | lint | test`. Tests run in jsdom; layout
facts jsdom can't compute (token values, contrast) are tested by parsing the CSS files.
