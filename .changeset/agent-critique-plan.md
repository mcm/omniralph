---
"@omniralph/agent": patch
---

Adds the plan critic playbook, `builtin:critique-plan` (role `verifier`): a read-only session that judges a triage draft (a Fix, a Story or an Epic, given under `critique` in its trigger context) against the rubric for its size from `@omniralph/planning` (`PLAN_RUBRICS`), and answers `{ verdict, notes: [{ item, ok, note }], openQuestions }`, which `PlanCritiqueOutput` in `@omniralph/shared` parses.
