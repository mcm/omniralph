---
"@omniralph/agent": patch
---

Agents measure what they store and keep track of their repos. They size the repo cache, worktrees, branch worktrees, packages, caches and logs, read the free space of each disk they write to (low under 5 GB or 10 % free), and list each cached repo with its size, last fetch, last sync and whether it's pinned to the agent. The heartbeat response now names pinned repositories by provider and path. The agent page will show all of this.
