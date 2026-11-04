---
"@omniralph/agent": patch
---

Story sessions report the work they discover they are blocked by: the story result has an optional `blockedBy` list of tracker identifiers (trimmed, de-duplicated case-insensitively, at most 10), which the agent passes on to the orchestrator. The story prompts tell the agent to report `status: "blocked"` with `blockedBy` instead of ever asking for another branch to be merged into its own.
