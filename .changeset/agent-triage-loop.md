---
"@omniralph/agent": patch
---

Triage runs as a loop: `builtin:triage` names `builtin:critique-plan` as its verifier (3 rounds at most), and a round after the first is told to revise its previous draft with what the work item lint and the plan critic found (the `revision` trigger variables, quoted as `<revision-feedback>`).
