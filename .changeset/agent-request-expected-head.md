---
"@omniralph/agent": patch
---

Request runs can be bound to a checked head. When a `ralph.request` payload carries `expectedHeadSha` (a run committing a documentation check's updates to a person's PR/MR), the attempt fails without starting a session if the branch is no longer at that commit, and `ship` makes one normal commit on top of it: it refuses `forceWithLease`, a worktree that moved past the checked head (so only one commit is ever pushed), and a branch someone pushed to on `origin` meanwhile.
