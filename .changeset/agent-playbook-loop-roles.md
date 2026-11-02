---
"@omniralph/agent": patch
---

Playbook roles now declare whether their runs loop, with the new `verifier` and `audit` roles and a `loop` block (most iterations, stall rounds) for looped playbooks that don't code.
