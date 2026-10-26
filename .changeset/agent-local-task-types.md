---
"@omniralph/agent": minor
---

The agent decides which task types it runs: set `acceptedTaskTypes` in its local config (`agent.json`, a non-empty list of `query`, `review` and `coding`; all when unset). It reports the list in every heartbeat and claim, only claims jobs of those types and only asks for the pools they run in. The control panel no longer sends accepted task types to agents that report their own, and shows them read-only.
