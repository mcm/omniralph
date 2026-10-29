# Design: the agent's local UI

`apps/web/DESIGN.md` is the authority for this UI too: the Design rules 1–24, the Decided
items, the widths, WCAG 2.2 AA in both themes and `@omniralph/ui` (`packages/ui`) for every
token and component. This file records only where the local UI departs from it.

- **One machine.** The page describes the agent it is served by, so it has no organization
  badges and no organization picker, and rule 13 doesn't apply.
- **Served on 127.0.0.1.** The agent's local HTTP server serves the bundle on the loopback
  address only. Fonts are self-hosted through `@omniralph/ui/fonts.css`, so it works offline.
- **No account.** The theme preference (System, Dark or Light) is kept in this browser
  (`src/theme.ts`), not saved per user.
- **Its own navigation.** A section nav (`src/nav.ts`: Agent, Settings and Machine groups)
  takes the place of the control panel's sidebar, icon rail and tab bar; a section gets a
  coral dot only for its problem (rules 9 and 15).
- **No canvas board.** The screens are held to the Design rules and the `@omniralph/ui`
  components.
