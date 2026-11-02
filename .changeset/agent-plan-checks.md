---
"@omniralph/agent": patch
---

The review engine can plan a looped review's check types (`planChecks`): security, stability, performance, compatibility and, when enabled, maintainability, each with the files it covers. Above 20 files, every check type reads the same directory groups, and the remaining token budget is split across check types and, by estimated size, across their groups. Reviews don't use it yet.
