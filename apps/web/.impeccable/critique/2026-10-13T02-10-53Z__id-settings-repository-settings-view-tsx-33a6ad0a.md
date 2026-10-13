---
target: repository settings page
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/steve/Documents/git/omniralph-screens/apps/web/src/app/(app)/repositories/[id]/settings/repository-settings-view.tsx"
target_fingerprint: "sha256:53032c7c60520f486051fbbef8c773edcb181d6b4eeaef715cc6aed11fe91a0a"
target_path: /Users/steve/Documents/git/omniralph-screens/apps/web/src/app/(app)/repositories/[id]/settings/repository-settings-view.tsx
timestamp: 2026-10-13T02-10-53Z
slug: id-settings-repository-settings-view-tsx-33a6ad0a
---
# Critique: repository settings (apps/web @ 5d26c1b, ui 1.0)
Method: dual-agent. Total 21/40 (Acceptable). P0 0, P1 3, P2 2, P3 1.
Heuristics: 1=2 2=3 3=1 4=2 5=2 6=2 7=2 8=2 9=2 10=3
P1 Client-side validation failures are silent and off-screen (repository-settings-view.tsx:176-179, ralph-settings-section.tsx:196-198).
P1 Run-affecting saves have no confirmation/diff/dirty state; tab nav drops edits.
P1 390px layout broken: sidebar persists, h1 overflows, header overlaps.
P2 Inapplicable fields stay live (Legacy path task pickers required; ralph-off cards editable).
P2 No defaults shown; key suffixes inconsistent (includeDrafts vs triggers.drafts).
P3 Oversized h1, inline styles, 11 equal cards; skipped heading h1->h3.
Detector: source clean; rendered 106 warnings/variant (32 low-contrast, 22 tiny-text, 18 tight-leading, 13 cramped-padding [false positives], 11 bounce-easing, 7 undersized-ui-text, 1 layout-transition, 1 overused-font, 1 skipped-heading).
