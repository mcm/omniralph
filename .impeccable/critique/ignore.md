# Critique ignore list

Findings a review round judged false positives, and the user's Decided items
(`apps/web/DESIGN.md`, "Decided — never flag, never undo"). Later rounds drop matching critique
and `impeccable detect` findings without re-arguing them. Each entry names the rule, its scope
and why it is not a defect. A `decided:` entry never suppresses an axe, keyboard, Escape or
landmark finding.

| Rule | Scope | Reason | Round |
|---|---|---|---|
| broken-image | `apps/web/src/lib/review/sanitize.test.ts` (any `*.test.ts`) | The `<img>` is in a test title and a string fixture proving the sanitizer strips images; it is never rendered. | TOOL-401 round 1 |
| overused-font | Geist Mono (`--or-font-mono` in `packages/ui/styles/fonts.css`) | The design system's mono font; DESIGN.md requires mono for IDs, SHAs and exact values. | TOOL-401 round 1 |
| decided: detail-actions-toolbar | 2.0 code: `apps/web/src`, `packages/ui/src`, the agent's local UI source | The user: "I genuinely don't care" if it goes against impeccable. | TOOL-730 |
| decided: metadata-is-a-badge | 2.0 code: `apps/web/src`, `packages/ui/src`, the agent's local UI source | A badge with its icon says what kind of thing a value is at a glance, so nobody guesses at a bare name. | TOOL-730 |
| decided: icon-badge-text | 2.0 code: `apps/web/src`, `packages/ui/src`, the agent's local UI source | Dense rows scan faster with icons and badges than with words. | TOOL-730 |
| decided: no-location-hints | 2.0 code: `apps/web/src`, `packages/ui/src`, the agent's local UI source | If the layout needs a hint, the layout is wrong. | TOOL-730 |
| decided: no-shortcut-indicators | 2.0 code: `apps/web/src`, `packages/ui/src`, the agent's local UI source | Shortcuts are one key per action across the app, and the Help page lists every one. | TOOL-730 |
| decided: no-live-indicator | 2.0 code: `apps/web/src`, `packages/ui/src`, the agent's local UI source | The whole UI is live, so only a stop in live updates is worth a notice. | TOOL-730 |
| decided: no-row-status-summaries | 2.0 code: `apps/web/src`, `packages/ui/src`, the agent's local UI source | Reasons, summaries and counts live in the detail, and status shows only when something is abnormal. | TOOL-730 |
| decided: light-phone-layout | 2.0 code: `apps/web/src`, `packages/ui/src`, the agent's local UI source | A phone visit is a quick check or a decision, so the phone carries less. | TOOL-730 |
| decided: static-glyph | 2.0 code: `apps/web/src`, `packages/ui/src`, the agent's local UI source | The logo decision keeps the Cursor still at every size. | TOOL-730 |
| decided: no-persona-framing | 2.0 code: `apps/web/src`, `packages/ui/src`, the agent's local UI source | The users are the organization's members, described by what they do, not by a persona. | TOOL-730 |
| decided: organization-badge-first | 2.0 code: `apps/web/src`, `packages/ui/src`, the agent's local UI source | Across organizations, which one an item belongs to is the first thing to know. | TOOL-730 |
| decided: mint-and-lavender | 2.0 code: `apps/web/src`, `packages/ui/src`, the agent's local UI source | Lavender stays rare so that it always means the screen needs you. | TOOL-730 |
