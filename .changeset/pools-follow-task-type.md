---
"@omniralph/agent": patch
---

A task definition no longer has a `pool`: a job's pool follows from its task type (`long` for coding runs, `short` for query and review runs). Claims still report each job's pool, so the agent's per-pool slot accounting is unchanged.
