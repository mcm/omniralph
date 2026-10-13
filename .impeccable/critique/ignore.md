# Critique ignore list

Detector findings judged false positives by a review round. Later rounds drop matching findings
without re-arguing them. Each entry names the rule, its scope and why it is not a defect.

| Rule | Scope | Reason | Round |
|---|---|---|---|
| broken-image | `apps/web/src/lib/review/sanitize.test.ts` (any `*.test.ts`) | The `<img>` is in a test title and a string fixture proving the sanitizer strips images; it is never rendered. | TOOL-401 round 1 |
| marquee | library `ui.css` `.whiteout::after` (`whiteout-sheen` animation) | The design system's Skeleton loading sheen (DESIGN.md). It fires from the bundled stylesheet even when no skeleton is on the page. | TOOL-401 round 1 |
| radial-halo | library `ui.css` `.aurora-field-blob-*` | `AuroraField` styles from the bundled stylesheet. The field renders only on the sign-in, onboarding and legal shells, which DESIGN.md allows; data pages don't render it. | TOOL-401 round 1 |
| overused-font | Geist Mono | The library's `--font-mono`; DESIGN.md requires mono for IDs, SHAs and exact values. | TOOL-401 round 1 |
| cramped-padding | library `Card`, `Badge`, `Alert`, `Select`, `ChartContainer`, `Metric`, Tabs list and dialog footers, app-shell sidebar/header/footer, `Avatar`, bordered boxes padded with `--space-*` | The static-HTML scan can't resolve Tailwind v4 `calc(var(--spacing) * n)` padding and reads it as 0; the screenshots show normal insets. | TOOL-401 round 1 (scope widened in round 2) |
| tight-leading | library `Field` description (`leading-tight`), `Label` (`leading-none`), `CardTitle` | Library typography, not set by the panel. The 1.00× case is a single-line label. | TOOL-401 round 1 |
| em-dash-overuse | built-in rubric reference `<pre>` on `settings-agent*`; `—` empty-cell placeholders | Shown content and the empty-value convention, not prose copy. | TOOL-401 round 1 |

Removed in round 2: `nested-cards` on the analytics `StatCard` icon tile (StatCard no longer exists; the rule now fires on `ChartContainer` inside `Card`, which is a real finding).
