---
"@omniralph/agent": patch
---

Triage sizes every work item as a Fix, a Story, an Epic or a Feature: `builtin:triage` answers a `sizing` (`{ size, reason }`) and, for a Feature, a first cut of its epics (`featureEpics`), in place of the top-level `kind` (a single task's kind now follows its size). The shared sizing rule of `@omniralph/planning` describes the four sizes.
