---
"@omniralph/agent": patch
---

Review task runs report documentation updates. A session's answer may carry `documentationUpdates` (`{ path, reason, suggestion? }` per file), parsed and repaired like its findings and summary; a documentation check (`builtin:check-docs`, whose trigger context carries `documentation`) always reports them in its result, one per file, and other reviews only when a session answered with them.
