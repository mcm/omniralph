---
"@omniralph/agent": patch
---

Approved worktree commands no longer inherit the agent process's `GIT_CONFIG_*` overrides, so they never see a git credential helper.
