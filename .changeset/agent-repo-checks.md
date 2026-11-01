---
"@omniralph/agent": minor
---

Story and request runs now run the lane repository's checks (set on its Coding card) where a playbook's verify commands ran before. The story prompt's "Checked by the Orchestrator" section lists them through the new `checks` template variable, which replaces the coding playbook's verify commands variable.
