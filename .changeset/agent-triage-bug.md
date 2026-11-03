---
"@omniralph/agent": patch
---

Triage locates the cause of a bug: for a Fix, `builtin:triage` answers a `bug` (the files and functions of the likely cause, the reproduction steps, and the current and expected behavior), read with `Read`, `Grep` and `Glob` only. A cause it can't locate becomes an open question (`bug.unlocatedQuestion`) instead of a guess.
