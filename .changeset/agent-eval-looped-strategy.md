---
"@omniralph/agent": patch
---

`pnpm eval --strategy looped` runs looped reviews in process (check-type passes planned by `planChecks`, a fresh finding verifier session after each pass, the depth's pass caps and the merge) beside the single-pass baseline. The review engine's provider can now verify findings (`verifyFindings`), and the pass settling logic moved into the engine (`@omniralph/engine/passes`).
