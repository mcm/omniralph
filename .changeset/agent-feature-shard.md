---
"@omniralph/agent": patch
---

The agent can run a feature's sharding: the new built-in playbooks `builtin:shard-plan` (role `shard`, drafting a feature's epics from its Plan in the epic format, each with the Plan sections it covers and the epics it waits for) and `builtin:verify-shard` (role `verifier`, checking every section is covered, no epic adds scope the Plan lacks and the epic→epic dependencies are acyclic) are `run.invoked` query runs whose invoker is the new `feature-shard` kind, labelled "Sharding a feature's plan into epics" and "Checking the epics drafted from a feature's plan".
